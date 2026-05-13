#!/bin/bash
set -e

yum update -y
yum install -y python3 python3-pip git

# Create log directory
mkdir -p /home/ec2-user/logs
chown ec2-user:ec2-user /home/ec2-user/logs

# Clone repo
cd /home/ec2-user
git clone https://github.com/am3855/IT342-FitLog.git app
chown -R ec2-user:ec2-user /home/ec2-user/app

# Install dependencies
cd /home/ec2-user/app
pip3 install -r requirements.txt

# Load env vars from AWS SSM Parameter Store if available
# Parameters should be stored under /fitlog/<NAME>
for PARAM in SECRET_KEY ANTHROPIC_API_KEY MAIL_EMAIL MAIL_PASSWORD AWS_REGION; do
  VALUE=$(aws ssm get-parameter --name "/fitlog/$PARAM" --with-decryption --query "Parameter.Value" --output text 2>/dev/null || echo "")
  if [ -n "$VALUE" ]; then
    echo "export $PARAM=$VALUE" >> /home/ec2-user/app/.env.runtime
  fi
done

# Create systemd service
cat > /etc/systemd/system/fitlog.service << 'EOF'
[Unit]
Description=FitLog Flask Application
After=network.target

[Service]
User=ec2-user
WorkingDirectory=/home/ec2-user/app
EnvironmentFile=-/home/ec2-user/app/.env
ExecStart=/usr/bin/python3 app.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fitlog

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable fitlog
systemctl start fitlog

echo "FitLog deployment complete."
