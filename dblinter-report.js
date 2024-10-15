const fs = require('fs');
const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const docker = require('docker-cli-js');
const crypto = require("node:crypto");

function buildReport(reportPath) {
    const actualContent = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    let report = "# DBLinter Report:\n\n";

    if (actualContent.runs[0].results && actualContent.runs[0].results.length > 0) {
        report += "## Issues found:\n";
        report += "```diff\n";
        actualContent.runs[0].results.forEach(r => {
            report += `- ⚠️ ${r.ruleId} ${r.message.text}\n`
            report += `+ ↪️ ${r.fixes}\n\n`
        });
        report += "```\n";
    } else {
        report += "No issues found";
    }
    return report;
}

async function createComment(report, options) {
    const context = github.context;

    const octokit = github.getOctokit(options.githubToken);

    const issue_number = context.payload.pull_request?.number;

    let comment;
    for await (const {data: comments} of octokit.paginate.iterator(octokit.rest.issues.listComments, {
        ...context.repo,
        issue_number,
    })) {
        comment = comments.find((comment) => comment?.body?.includes("# DBLinter Report:"));
        if (comment) break;
    }

    if (comment) {
        await octokit.rest.issues.updateComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            comment_id: comment.id,
            body: report
        });
    } else {
        await octokit.rest.issues.createComment({
            issue_number: issue_number,
            owner: context.repo.owner,
            repo: context.repo.repo,
            body: report
        })
    }
}


function validateInputForExec(input) {
    const value = core.getInput(input);
    if (!value) {
        core.setFailed(`${input} is required`);
        exit(1);
    }
    const regex = /^[a-zA-Z0-9.-_]+$/;
    if(!regex.test(value)) {
        core.setFailed(`${input} should only contain alphanumeric characters, dot, hyphens, underscores. It is '${value}'`);
        exit(1);
    }

    return value;
}

function validateInput(){
    let reportPathInput=core.getInput('report-path');
    if (!reportPathInput) {
        core.setFailed('report-path is required');
        exit(1);
    }
    let filename=reportPathInput;
    let directory=".";
    if (reportPathInput.includes("/")) {
        directory = reportPathInput.split('/').slice(0, -1).join('/');
        filename = reportPathInput.split('/').pop();
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    }

    const reportDir = fs.realpathSync(directory);
    const reportPath = `${reportDir}/${filename}`;
    const reportFileName = filename;

    let configFile=core.getInput("config-file");
    let configFileDir = "";
    let configFileName = "";
    if (configFile) {
        if (!fs.existsSync(config)){
            core.setFailed(`Config file not found: ${configFile}`);
            exit(1);
        }
        configFile = fs.realpathSync(configFile);
        configFileDir = configFile.split('/').slice(0, -1).join('/');
        configFileName = configFile.split('/').pop();
    }


    let flywayMigration = core.getInput('flyway-migration');
    if (flywayMigration) {
        flywayMigration = fs.realpathSync(flywayMigration);
        if (!fs.existsSync(flywayMigration)) {
            core.setFailed(`Flyway migration file not found: ${flywayMigration}`);
            exit(1);
        }
    }

    let initScript = core.getInput('init-script');
    if (initScript) {
        initScript = fs.realpathSync(initScript);
        if (!fs.existsSync(initScript)) {
            core.setFailed(`Init script file not found: ${initScript}`);
            exit(1);
        }
    }

    const dblinterVersion = validateInputForExec("dblinter-version");
    const postgresVersion = validateInputForExec("postgres-version");
    const flywayVersion = validateInputForExec("flyway-version");

    const inPR = github.context.eventName.toLowerCase()==='pull_request'
    const prComment = inPR && core.getInput('pr-comment')==='true';
    const githubToken = core.getInput('GITHUB_TOKEN');
    if ( inPR && prComment && !githubToken) {
        core.setFailed("GITHUB_TOKEN is required to create a PR comment");
        exit(1);
    }



    return {
        reportPath,
        reportDir,
        reportFileName,
        configFileDir,
        configFileName,
        flywayMigration,
        initScript,
        dblinterVersion,
        postgresVersion,
        flywayVersion,
        prComment,
        githubToken,
    };
}

async function downloadDockerImage(config){
    console.log("We will use: ");
    docker.dockerCommand('pull -q decathlon/dblinter:'+config.dblinterVersion);
    docker.dockerCommand('pull -q flyway/flyway:'+config.flywayVersion);
    await docker.dockerCommand('pull -q postgres:'+config.postgresVersion);
}


async function launchPostgres(config) {
    const pgPass = crypto.randomBytes(16).toString('hex');
    core.setSecret(pgPass);

    console.log("------------ pg container ------------");
    const container=await docker.dockerCommand(`run -d -e POSTGRES_PASSWORD=${pgPass} postgres:${config.postgresVersion}`);
    const inspect= await docker.dockerCommand(`inspect ${container.containerId} -f '{"ip":"{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}"}'`, {echo: false});
    console.log(`postgres is bound on ip: ${inspect.object.ip}`);
    console.log("------------ /pg container ------------");

    return {
        pgContainer: container.containerId,
        pgHost: inspect.object.ip,
        pgPort: 5432,
        pgUser: 'postgres',
        pgPass,
        pgDatabase: 'postgres',
    };

}

async function executeFlyway(config, postgres) {
    if (!config.flywayMigration) {
        console.log("No flyway migration file found\n");
        return;
    }
    console.log(`Flyway migration file found ${config.flywayVersion}`);
    await docker.dockerCommand(`run --rm -v ${config.flywayMigration}:/flyway/sql flyway/flyway:${config.flywayVersion} -locations="filesystem:/flyway/sql" -url=jdbc:postgresql://${postgres.pgHost}:${postgres.pgPort}/${postgres.pgDatabase} -user=${postgres.pgUser} -password=${postgres.pgPass} migrate`);
    console.log("\n");
}

async function executeInitSql(config, postgres){
    if (!config.initScript) {
        console.log("No init script found");
        return;
    }
    console.log(`Init script found ${config.initScript}`);
    const exitCode = await exec.exec("psql",
        ["-v","ON_ERROR_STOP=1", "-f", config.initScript],
        {env: {
            PGPASSWORD: postgres.pgPass,
            PGHOST: postgres.pgHost,
            PGPORT: postgres.pgPort,
            PGUSER: postgres.pgUser,
            PGDATABASE: postgres.pgDatabase
            }});

    console.log("\n");
    if (exitCode !== 0) {
        core.setFailed("Error executing init script");
        exit(1);
    }
}


async function executeDblinter(options, postgres) {
    const additionalVolumes = options.configFileDir ? `-v ${options.configFileDir}:/config` : "";
    const additionalParams = options.configFileName ? `-f /config/${options.configFileName}` : "";

    console.log("----------------------------------------------------------------------");
    console.log("--                   Running dblinter now                           --");
    console.log("----------------------------------------------------------------------");
    await docker.dockerCommand(`run --rm -t -u $(id -u) ${additionalVolumes} -v ${options.reportDir}:/report  decathlon/dblinter:${options.dblinterVersion} ${additionalParams} --dbname ${postgres.pgDatabase} --host ${postgres.pgHost} --user ${postgres.pgUser} --password ${postgres.pgPass} --port ${postgres.pgPort} -o /report/${options.reportFileName}`);
    console.log("----------------------------------------------------------------------");
    console.log("--                   Dblinter scan finished                         --");
    console.log("----------------------------------------------------------------------");
}


async function main() {
    const options = validateInput();
    await downloadDockerImage(options);
    const postgres = await launchPostgres(options);

    await executeFlyway(options, postgres);
    await executeInitSql(options, postgres);


    await executeDblinter(options, postgres);

    core.setOutput("sarif-report", options.reportPath);

    await docker.dockerCommand(`kill ${postgres.pgContainer}`, {echo: false});

    if (options.prComment) {
        const report = buildReport(options.reportPath);
        await createComment(report, options);
    }
}


main();
