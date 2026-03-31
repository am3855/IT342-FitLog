---Milestone 1---



FitLog — Project Proposal
IT 342 — Cloud Infrastructure &amp; AWS Services

Project Overview
FitLog is a cloud-native fitness tracking web app where users create accounts, log workouts, and view progress
over time. The project demonstrates AWS cloud infrastructure skills — compute, networking, IAM, storage,
automation, and monitoring — in a real-world deployment.
Core Application Features
• User registration and login with secure password handling
• Workout logging — exercise name, sets, reps, weight, and date
• Workout history — browse and filter past sessions
• Progress tracking — view performance changes over time
• Admin interface for managing users and data
IT 342 — AWS Deliverables
Compute &amp; Hosting
• EC2 instance (Amazon Linux 2023) behind an Application Load Balancer with Auto Scaling
• Frontend deployed to S3 static hosting, served via CloudFront CDN with HTTPS
Networking &amp; Security
• Custom VPC with public and private subnets across two Availability Zones
• ALB in public subnet; EC2 in private subnet; NAT Gateway for outbound access
• Security Groups: port 443 open to internet on ALB only; EC2 accepts traffic from ALB only
• VPC Flow Logs enabled for network traffic auditing
IAM
• IAM users per role: read-only dev, app service role, admin — all least-privilege
• EC2 instance profile grants app access to S3 and RDS without stored credentials
Database &amp; Storage
• Amazon RDS (MySQL) in a private subnet with automated 7-day backup retention
• S3 bucket for user uploads and nightly DB backup exports — encrypted, no public access
Automation &amp; IaC
• CloudFormation template provisions full stack (VPC, EC2, RDS, S3, ALB) from scratch
• Lambda + EventBridge scheduled nightly: exports RDS snapshot to versioned S3 backup bucket
• EC2 User Data script bootstraps dependencies and starts the app on instance launch
Monitoring &amp; Logging
• CloudWatch metrics, alarms (CPU &gt; 80%, unhealthy hosts), and structured application logs
• CloudTrail enabled for full API audit trail across the account
Version Control
• Git + GitHub with main / dev / feature branch strategy; all merges documented with clear commit messages
Tech Stack
• Compute: EC2 (Amazon Linux 2023) + Auto Scaling Group
• Load Balancing: Application Load Balancer (ALB)
• Frontend: S3 static hosting + CloudFront

• Backend: Node.js / Express (or Python / Flask)
• Database: Amazon RDS — MySQL (or PostgreSQL / Aurora)
• Serverless: AWS Lambda + EventBridge (scheduled backups)
• Networking: VPC, Security Groups, NAT Gateway
• IAM: Users, roles, instance profiles, least-privilege policies
• Monitoring: CloudWatch, CloudTrail
• Version Control: Git + GitHub
