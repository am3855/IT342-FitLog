# FitLog

## Setup

AWS credentials must be configured before running. Set the following environment variables:

```
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_DEFAULT_REGION=us-east-1
SECRET_KEY=your_flask_secret_key
```

Or use the AWS CLI:

```
aws configure
```

The DynamoDB table `fitlog-users` is created automatically on first run if it does not already exist.

## Directory Structure

```
IT342-FitLog/
├── app.py                  
├── requirements.txt        
├── README.md
├── .gitignore
├── static/
│   ├── css/
│   │   └── style.css       
│   └── js/
│       └── main.js         
└── templates/
    └── index.html           
```

---

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Serves the application |
| POST | `/api/register` | Creates a new user account |
| POST | `/api/login` | Authenticates a user and starts a session |
| POST | `/api/logout` | Clears the session |
| GET | `/api/me` | Returns the current session user |

---

## Tech Stack

**Python / Flask** — serves the app, handles all routes and session management

**AWS DynamoDB** — stores users in table `fitlog-users` (partition key: `email`), `PAY_PER_REQUEST` billing, auto-created on first run

**boto3** — Python SDK for DynamoDB; uses IAM instance profile automatically on EC2

**Werkzeug** — password hashing, included with Flask

**HTML / CSS / JavaScript** — `index.html` renders all three views; `style.css` styles them; `main.js` handles view switching, form validation, and all API calls

---

## Docker (Local Testing)

Requires Docker Desktop to be installed and running.

```
docker-compose up --build
```

Open: `http://localhost:5000`

- The Flask app and a local DynamoDB instance start together.
- The `fitlog-users` table is created automatically on startup.
- No AWS credentials are needed for local testing.
- To stop: `docker-compose down`

---

## Connecting to DynamoDB

- Log in to the AWS Console and navigate to IAM, then create a user with the `AmazonDynamoDBFullAccess` policy attached.
- Generate an access key for that IAM user and copy the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values.
- Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION` as environment variables on the machine running the app.
- Confirm the region matches where you want the table created, as `app.py` defaults to `us-east-1` if `AWS_DEFAULT_REGION` is not set.
- Run `python app.py` and the app will call `create_table` on startup, creating the `fitlog-users` table automatically if it does not exist.
- To verify, open the AWS Console, go to DynamoDB, and confirm the `fitlog-users` table appears in your region.
- When deployed on EC2, attach an IAM role with `AmazonDynamoDBFullAccess` to the instance instead of using access keys.
