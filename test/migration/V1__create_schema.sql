create table employee_role (
    id INT PRIMARY KEY,
    role VARCHAR(30) NOT NULL
);

create table employee (
    id SERIAL PRIMARY KEY,
    firstname VARCHAR(20) NOT NULL,
    surname VARCHAR(20) NOT NULL,
    employee_role_id INT,
    FOREIGN KEY (employee_role_id) REFERENCES employee_role(id) ON DELETE CASCADE
);

create table client (
    id INT PRIMARY KEY,
    client_name VARCHAR(30) NOT NULL
);

create table project (
    id SERIAL PRIMARY KEY,
    project_title VARCHAR(20) NOT NULL,
    date_started DATE NOT NULL,
    date_ended DATE,
    client_id INT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES client(id) ON DELETE CASCADE
);

create table employee_project (
    employee_id INT,
    project_id INT,
    date_started DATE,
    date_ended DATE,
    PRIMARY KEY (employee_id, project_id)
);
