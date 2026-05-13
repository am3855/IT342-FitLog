# FitLog

A cloud-native fitness tracking application built with Flask, DynamoDB, and deployed on AWS EC2.

## Tech Stack

- **Backend**: Python / Flask
- **Database**: Amazon DynamoDB (boto3)
- **Frontend**: Single Page App — HTML, CSS, JavaScript, Chart.js
- **AI**: Anthropic Claude API
- **Exercise Data**: Wger REST API (no key required)
- **Email 2FA**: Gmail SMTP
- **Infrastructure**: AWS EC2 (Auto Scaling), ALB, S3, Lambda, CloudWatch, CloudTrail

## Features

- User registration and login with bcrypt password hashing
- Email-based two-factor authentication (2FA)
- Workout logging with live exercise search (Wger API)
- Full workout history with edit/delete and calories burned column
- Health metrics: BMI, heart rate zones, daily calorie recommendations, macro breakdown
- Workout progress charts (volume over time, frequency per week, calories burned) via Chart.js
- AI workout coach powered by Claude API
- User settings: username, email, body metrics, 2FA toggle
- Admin dashboard: manage all users and workouts, toggle 2FA, edit metrics
- Default admin account: `admin@fitlog.com` / `Admin123!`

## Directory Structure

```
IT342-FitLog/
├── app.py
├── requirements.txt
├── .env.example
├── .gitignore
├── README.md
├── Dockerfile
├── docker-compose.yml
├── templates/
│   └── index.html
├── static/
│   ├── css/style.css
│   └── js/main.js
└── aws/
    ├── cloudformation.yml
    └── userdata.sh
```

## Local Development

**Prerequisites**: Docker + Docker Compose

```bash
cp .env.example .env
# Fill in: SECRET_KEY, ANTHROPIC_API_KEY, MAIL_EMAIL, MAIL_PASSWORD

docker-compose up --build
```

App runs at `http://localhost:5000`

Docker Compose starts DynamoDB Local automatically. Tables and the admin account are created on first startup.

## AWS Deployment

### 1. Deploy the CloudFormation stack

```bash
aws cloudformation deploy \
  --template-file aws/cloudformation.yml \
  --stack-name fitlog-stack \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    SecretKey=<your-secret> \
    AnthropicApiKey=<your-claude-key> \
    MailEmail=<your-gmail> \
    MailPassword=<gmail-app-password>
```

### 2. (Recommended) Store secrets in SSM Parameter Store

```bash
aws ssm put-parameter --name /fitlog/SECRET_KEY --value "..." --type SecureString
aws ssm put-parameter --name /fitlog/ANTHROPIC_API_KEY --value "..." --type SecureString
aws ssm put-parameter --name /fitlog/MAIL_EMAIL --value "..." --type SecureString
aws ssm put-parameter --name /fitlog/MAIL_PASSWORD --value "..." --type SecureString
```

### 3. Access the app

The ALB DNS name is in the CloudFormation Outputs.

## Environment Variables

| Variable | Description |
|---|---|
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | Not needed on EC2 with IAM instance profile |
| `AWS_SECRET_ACCESS_KEY` | Not needed on EC2 with IAM instance profile |
| `SECRET_KEY` | Flask session secret key |
| `ANTHROPIC_API_KEY` | Claude API key for AI recommendations |
| `MAIL_EMAIL` | Gmail address for 2FA codes |
| `MAIL_PASSWORD` | Gmail App Password |
| `DYNAMODB_ENDPOINT_URL` | Local DynamoDB override (e.g. `http://localhost:8000`) |

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/register` | — | Register |
| POST | `/api/login` | — | Login |
| POST | `/api/2fa/verify` | — | Verify 2FA code |
| POST | `/api/2fa/enroll` | ✓ | Enable 2FA |
| POST | `/api/2fa/disable` | ✓ | Disable 2FA |
| GET | `/api/me` | — | Session user info |
| POST | `/api/logout` | ✓ | Logout |
| PUT | `/api/user/username` | ✓ | Change username |
| PUT | `/api/user/email` | ✓ | Change email |
| PUT | `/api/user/metrics` | ✓ | Update body metrics |
| GET | `/api/workouts` | ✓ | Get workouts |
| POST | `/api/workouts` | ✓ | Log workout |
| PUT | `/api/workouts/:id` | ✓ | Edit workout |
| DELETE | `/api/workouts/:id` | ✓ | Delete workout |
| GET | `/api/exercises/search?term=` | — | Search exercises |
| GET | `/api/muscles` | — | Muscle groups |
| GET | `/api/exercises/by-muscle?muscle_id=` | — | Exercises by muscle |
| POST | `/api/ai/recommendations` | ✓ | AI recommendations |
| GET | `/api/admin/users` | Admin | All users + workouts |
| PUT | `/api/admin/users/:id/toggle-2fa` | Admin | Toggle 2FA |
| PUT | `/api/admin/users/:id/email` | Admin | Update email |
| PUT | `/api/admin/users/:id/username` | Admin | Update username |
| PUT | `/api/admin/users/:id/metrics` | Admin | Update metrics |
| PUT | `/api/admin/workouts/:id` | Admin | Edit any workout |
| DELETE | `/api/admin/workouts/:id` | Admin | Delete any workout |
| GET | `/api/health` | — | ALB health check |
