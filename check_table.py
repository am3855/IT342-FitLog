import boto3
import os
from dotenv import load_dotenv
load_dotenv()

region = os.getenv('AWS_REGION', 'us-east-1')
key_id = os.getenv('AWS_ACCESS_KEY_ID')
secret = os.getenv('AWS_SECRET_ACCESS_KEY')
endpoint = os.getenv('DYNAMODB_ENDPOINT_URL')

kwargs = {'region_name': region}
if endpoint:
    kwargs['endpoint_url'] = endpoint
if key_id and secret:
    kwargs['aws_access_key_id'] = key_id
    kwargs['aws_secret_access_key'] = secret

print(f"Connecting to DynamoDB region={region} endpoint={endpoint or 'AWS'}")

dynamodb = boto3.client('dynamodb', **kwargs)

for table_name in ('fitlog-users', 'fitlog-workouts'):
    try:
        response = dynamodb.describe_table(TableName=table_name)
        t = response['Table']
        print(f"\n=== {table_name} ===")
        print("KEY SCHEMA:", t['KeySchema'])
        print("ATTRIBUTE DEFINITIONS:", t['AttributeDefinitions'])
        gsis = t.get('GlobalSecondaryIndexes', [])
        print("GSIs:", [g['IndexName'] for g in gsis])
        for gsi in gsis:
            print(f"  GSI {gsi['IndexName']}: keys={gsi['KeySchema']}")
    except Exception as e:
        print(f"\n=== {table_name} ERROR: {e}")
