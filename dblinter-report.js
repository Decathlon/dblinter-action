const fs = require('fs');
const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const docker = require('docker-cli-js');

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

async function createComment(report) {
    const context = github.context;

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
            issue_number: context.payload.pull_request?.number,
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
    if(!regex.test(input)) {
        core.setFailed(`${input} should only contain alphanumeric characters, dot, hyphens, underscores`);
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

    const prComment = core.getInput('pr-comment')==='true';
    const githubToken = core.getInput('GITHUB_TOKEN');
    if ( (github.context.eventName.toLowerCase()==='pull_request') && prComment && !githubToken) {
        core.setFailed("GITHUB_TOKEN is required to create a PR comment");
        exit(1);
    }



    return {
        reportPath,
        reportDir,
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
    docker.dockerCommand('pull decathlon/dblinter:'+config.dblinterVersion);
    docker.dockerCommand('pull flyway/flyway:'+config.flywayVersion);
    await docker.dockerCommand('pull postgres:'+config.postgresVersion);
}


async function launchPostgres(config) {
    const pgPass = Buffer.from(crypto.randomBytes(12)).toString('base64').replace(/\//g, '_');
    core.setSecret(pgPass);

    const container=await docker.dockerCommand(`run -d -e POSTGRES_PASSWORD=${pgPass} postgres:${config.postgresVersion}`);
    console.log("------------ container ------------");
    console.log(container);
    console.log("------------ /container ------------");

    const inspect= await docker.dockerCommand(`inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${container.containerId}`);
    console.log("------------ inspect ------------");
    console.log(inspect);
    console.log("------------ /inspect ------------");

    return {
        pgContainer: container.containerId,
        pgHost: inspect.raw,
        pgPort: 5432,
        pgUser: 'postgres',
        pgPass,
        pgDatabase: 'postgres',
    };

}

async function executeFlyway(config, postgres) {
    if (!config.flywayMigration) {
        return;
    }
    await docker.dockerCommand(`run --rm -v ${config.flywayMigration}:/flyway/sql flyway/flyway:${config.flywayVersion} -locations="filesystem:/flyway/sql" -url=jdbc:postgresql://${postgres.pgHost}:${postgres.pgPort}/${postgres.pgDatabase} -user=${postgres.pgUser} -password=${postgres.pgPass} migrate`, {stdio: 'inherit'});
}

async function executeInitSql(config, postgres){
    if (!config.initScript) {
        return;
    }

    const exitCode = await exec.exec("psql",
        ["-v","ON_ERROR_STOP=1", "-f", config.initScript],
        {env: {
            PGPASSWORD: postgres.pgPass,
            PGHOST: postgres.pgHost,
            PGPORT: postgres.pgPort,
            PGUSER: postgres.pgUser,
            PGDATABASE: postgres.pgDatabase
            }});

    if (exitCode !== 0) {
        core.setFailed("Error executing init script");
        exit(1);
    }
}


async function executeDblinter(options, postgres) {
    console.log("----------------------------------------------------------------------");
    console.log("--                   Running dblinter now                           --");
    console.log("----------------------------------------------------------------------");
    docker.dockerCommand("run --rm -t -u $(id -u) -v $ABSOLUTE_OUTPUT_DIR:/report  decathlon/dblinter:${{inputs.dblinter-version}} --dbname $PGDATABASE --host $PGHOST --user $PGUSER --password $PGPASSWORD --port $PGPORT -o /report/$FILENAME", {stdio: 'inherit'});
    console.log("----------------------------------------------------------------------");
    console.log("--                   Dblinter scan finished                         --");
    console.log("----------------------------------------------------------------------");
}


async function main() {
    const options = validateInput();
    console.log("options: ", options);
    await downloadDockerImage(options);
    const postgres = await launchPostgres(options);

    await executeFlyway(options, postgres);
    await executeInitSql(options, postgres);


    await executeDblinter(options, postgres);

    core.setOutput("sarif-report", options.reportPath);

    docker.dockerCommand(`kill ${postgres.pgContainer}`);

    const report = buildReport(options.reportPath);

    const github_token = core.getInput('GITHUB_TOKEN');
    const octokit = github.getOctokit(github_token);

    const context = github.context;
    const issue_number = context.payload.pull_request?.number;

    if (!issue_number) {
        core.info('No issue number found.');
    } else {
        createComment(report);
    }
}


main();
