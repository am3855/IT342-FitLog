from flask import Flask, request, jsonify, session, render_template
from flask_cors import CORS
import bcrypt
import boto3
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError
import uuid
import os
import re
import logging
import json
import random
import string
import hmac
from decimal import Decimal
from datetime import datetime, timedelta
import smtplib
from email.mime.text import MIMEText
import requests
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'fitlog-dev-secret-change-in-prod')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = 3600

_cors_origins = os.environ.get('CORS_ORIGINS', '*')
CORS(app, origins=_cors_origins, supports_credentials=True)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

WGER_BASE = 'https://wger.de/api/v2'


def to_dec(v):
    """Convert a numeric value to Decimal for DynamoDB storage."""
    if v is None:
        return None
    return Decimal(str(v))


# ── DynamoDB helpers ──────────────────────────────────────────────────────────

def get_dynamodb():
    kwargs = {'region_name': os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', 'us-east-1'))}
    endpoint = os.environ.get('DYNAMODB_ENDPOINT_URL')
    if endpoint:
        kwargs['endpoint_url'] = endpoint
    key_id = os.environ.get('AWS_ACCESS_KEY_ID')
    secret = os.environ.get('AWS_SECRET_ACCESS_KEY')
    if key_id and secret:
        kwargs['aws_access_key_id'] = key_id
        kwargs['aws_secret_access_key'] = secret
    return boto3.resource('dynamodb', **kwargs)


def users_table():
    return get_dynamodb().Table('fitlog-users')


def workouts_table():
    return get_dynamodb().Table('fitlog-workouts')


def clean(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean(i) for i in obj]
    return obj


def get_user_by_email(email):
    try:
        r = users_table().query(
            IndexName='email-index',
            KeyConditionExpression=Key('email').eq(email)
        )
        items = r.get('Items', [])
        if items:
            logger.info(f'get_user_by_email: found via GSI for {email}')
            return clean(items[0])
        return None
    except Exception as e:
        # GSI may not exist on this table yet — fall back to full scan
        logger.warning(f'get_user_by_email GSI query failed ({e}), falling back to scan')
        try:
            r = users_table().scan(FilterExpression=Attr('email').eq(email))
            items = r.get('Items', [])
            if items:
                logger.info(f'get_user_by_email: found via scan for {email}')
            return clean(items[0]) if items else None
        except Exception as e2:
            logger.error(f'get_user_by_email scan also failed: {e2}')
            return None


def get_user_by_username(username):
    try:
        r = users_table().query(
            IndexName='username-index',
            KeyConditionExpression=Key('username').eq(username)
        )
        items = r.get('Items', [])
        return clean(items[0]) if items else None
    except Exception as e:
        # GSI may not exist on this table yet — fall back to full scan
        logger.warning(f'get_user_by_username GSI query failed ({e}), falling back to scan')
        try:
            r = users_table().scan(FilterExpression=Attr('username').eq(username))
            items = r.get('Items', [])
            return clean(items[0]) if items else None
        except Exception as e2:
            logger.error(f'get_user_by_username scan also failed: {e2}')
            return None


def get_user_by_id(user_id):
    r = users_table().get_item(Key={'user_id': str(user_id)})
    item = r.get('Item')
    return clean(item) if item else None


# ── Validators ────────────────────────────────────────────────────────────────

def valid_email(email):
    return bool(email and len(email) <= 254 and
                re.match(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$', email))


def valid_username(u):
    return bool(u and 3 <= len(u) <= 30 and re.match(r'^[a-zA-Z0-9_.\-]+$', u))


# ── Email ─────────────────────────────────────────────────────────────────────

def send_2fa_email(to_email, code):
    mail_user = os.environ.get('MAIL_EMAIL')
    mail_pass = os.environ.get('MAIL_PASSWORD')
    if not mail_user or not mail_pass:
        logger.warning('Mail credentials not set — skipping 2FA email')
        return False
    body = (f'Your FitLog login verification code is: {code}\n'
            f'This code expires in 10 minutes.\n'
            f'If you did not request this, please ignore this email.')
    msg = MIMEText(body)
    msg['Subject'] = 'Your FitLog verification code'
    msg['From'] = mail_user
    msg['To'] = to_email
    try:
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp:
            smtp.login(mail_user, mail_pass)
            smtp.send_message(msg)
        return True
    except Exception as e:
        logger.error(f'send_2fa_email failed: {e}')
        return False


# ── Auth decorators ───────────────────────────────────────────────────────────

from functools import wraps


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return decorated


def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Authentication required'}), 401
        if not session.get('is_admin'):
            return jsonify({'error': 'Admin access required'}), 403
        return f(*args, **kwargs)
    return decorated


# ── DB init & seed ────────────────────────────────────────────────────────────

def init_db():
    db = get_dynamodb()

    # fitlog-users
    try:
        db.create_table(
            TableName='fitlog-users',
            KeySchema=[{'AttributeName': 'user_id', 'KeyType': 'HASH'}],
            AttributeDefinitions=[
                {'AttributeName': 'user_id', 'AttributeType': 'S'},
                {'AttributeName': 'email', 'AttributeType': 'S'},
                {'AttributeName': 'username', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'email-index',
                    'KeySchema': [{'AttributeName': 'email', 'KeyType': 'HASH'}],
                    'Projection': {'ProjectionType': 'ALL'},
                },
                {
                    'IndexName': 'username-index',
                    'KeySchema': [{'AttributeName': 'username', 'KeyType': 'HASH'}],
                    'Projection': {'ProjectionType': 'ALL'},
                },
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        db.Table('fitlog-users').wait_until_exists()
        logger.info('Created fitlog-users table')
    except ClientError as e:
        if e.response['Error']['Code'] != 'ResourceInUseException':
            raise

    # fitlog-workouts
    try:
        db.create_table(
            TableName='fitlog-workouts',
            KeySchema=[{'AttributeName': 'workout_id', 'KeyType': 'HASH'}],
            AttributeDefinitions=[
                {'AttributeName': 'workout_id', 'AttributeType': 'S'},
                {'AttributeName': 'user_id', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'user_id-index',
                    'KeySchema': [{'AttributeName': 'user_id', 'KeyType': 'HASH'}],
                    'Projection': {'ProjectionType': 'ALL'},
                },
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        db.Table('fitlog-workouts').wait_until_exists()
        logger.info('Created fitlog-workouts table')
    except ClientError as e:
        if e.response['Error']['Code'] != 'ResourceInUseException':
            raise

    # Log actual table schema so key mismatches are immediately visible in server logs
    try:
        client = db.meta.client
        for tname in ('fitlog-users', 'fitlog-workouts'):
            desc = client.describe_table(TableName=tname)['Table']
            ks = [(k['AttributeName'], k['KeyType']) for k in desc['KeySchema']]
            ad = {a['AttributeName']: a['AttributeType'] for a in desc['AttributeDefinitions']}
            gsis = [g['IndexName'] for g in desc.get('GlobalSecondaryIndexes', [])]
            logger.info(f'SCHEMA {tname}: keys={ks} types={ad} gsis={gsis}')
    except Exception as e:
        logger.error(f'SCHEMA check failed: {e}')

    # Seed admin — use scan without Limit so all items are checked.
    # Limit=N on a DynamoDB scan limits items EVALUATED before filtering, not items matched.
    # Using Limit=1 would only check 1 random item and incorrectly conclude admin doesn't exist.
    try:
        scan_result = users_table().scan(
            FilterExpression=Attr('email').eq('admin@fitlog.com'),
        )
        if not scan_result.get('Items'):
            pw_hash = bcrypt.hashpw(b'Admin123!', bcrypt.gensalt()).decode()
            users_table().put_item(Item={
                'user_id': str(uuid.uuid4()),
                'username': 'admin',
                'email': 'admin@fitlog.com',
                'password_hash': pw_hash,
                'is_admin': True,
                'created_at': datetime.utcnow().isoformat(),
                '2fa_enabled': False,
                'age': None,
                'weight': None,
                'height': None,
                'gender': None,
                'unit_preference': 'imperial',
            })
            logger.info('STARTUP: Admin account created — admin@fitlog.com / Admin123!')
        else:
            admin = scan_result['Items'][0]
            logger.info(f'STARTUP: Admin account exists — user_id={admin.get("user_id")}, email={admin.get("email")}')
    except Exception as e:
        logger.error(f'STARTUP: Admin seed check failed: {e}')


# ── Global error handlers (always return JSON, never HTML) ────────────────────

from werkzeug.exceptions import HTTPException


@app.errorhandler(Exception)
def handle_exception(e):
    if isinstance(e, HTTPException):
        return jsonify({'error': e.description}), e.code
    logger.exception(f'Unhandled exception: {e}')
    return jsonify({'error': 'Internal server error. Check server logs.'}), 500


# ── Routes: core ─────────────────────────────────────────────────────────────

@app.route('/')
def index():
    backend_url = os.environ.get('BACKEND_URL', '')
    return render_template('index.html', backend_url=backend_url)


@app.route('/api/health')
def health():
    return jsonify({'status': 'healthy'})


# ── Routes: auth ──────────────────────────────────────────────────────────────

@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    email = data.get('email', '').strip().lower()
    password = data.get('password', '')
    confirm = data.get('confirm_password', '')

    if not username or not email or not password or not confirm:
        return jsonify({'error': 'All fields are required.'}), 400
    if not valid_username(username):
        return jsonify({'error': 'Username must be 3-30 chars (letters, numbers, _ . -)'}), 400
    if not valid_email(email):
        return jsonify({'error': 'Please enter a valid email address.'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters.'}), 400
    if password != confirm:
        return jsonify({'error': 'Passwords do not match.'}), 400
    if get_user_by_email(email):
        return jsonify({'error': 'An account with that email already exists.'}), 409
    if get_user_by_username(username):
        return jsonify({'error': 'That username is already taken.'}), 409

    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user_id = str(uuid.uuid4())
    users_table().put_item(Item={
        'user_id': user_id,
        'username': username,
        'email': email,
        'password_hash': pw_hash,
        'is_admin': False,
        'created_at': datetime.utcnow().isoformat(),
        '2fa_enabled': False,
        'age': None,
        'weight': None,
        'height': None,
        'gender': None,
        'unit_preference': 'imperial',
    })
    session['user_id'] = user_id
    session['username'] = username
    session['is_admin'] = False
    logger.info(json.dumps({'event': 'register', 'email': email}))
    return jsonify({'success': True, 'user': {'username': username, 'email': email, 'is_admin': False}})


@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    email = data.get('email', '').strip().lower()
    password = data.get('password', '')

    if not email or not password:
        return jsonify({'error': 'Please enter your email and password.'}), 400

    logger.info(f'LOGIN: attempt for email={email}')
    user = get_user_by_email(email)
    if not user:
        logger.warning(f'LOGIN: no user found for email={email}')
        return jsonify({'error': 'Invalid email or password.'}), 401
    logger.info(f'LOGIN: user found user_id={user.get("user_id")} is_admin={user.get("is_admin")}')
    if not bcrypt.checkpw(password.encode(), user['password_hash'].encode()):
        logger.warning(f'LOGIN: wrong password for email={email}')
        return jsonify({'error': 'Invalid email or password.'}), 401

    if user.get('2fa_enabled'):
        code = ''.join(random.choices(string.digits, k=6))
        expires = (datetime.utcnow() + timedelta(minutes=10)).isoformat()
        users_table().update_item(
            Key={'user_id': str(user['user_id'])},
            UpdateExpression='SET #c = :code, #e = :exp',
            ExpressionAttributeNames={'#c': '2fa_code', '#e': '2fa_expires'},
            ExpressionAttributeValues={':code': code, ':exp': expires},
        )
        send_2fa_email(user['email'], code)
        session['pending_2fa_user_id'] = user['user_id']
        return jsonify({'requires_2fa': True})

    session['user_id'] = user['user_id']
    session['username'] = user['username']
    session['is_admin'] = user.get('is_admin', False)
    logger.info(json.dumps({'event': 'login', 'email': email}))
    return jsonify({'success': True, 'user': {
        'username': user['username'], 'email': user['email'],
        'is_admin': user.get('is_admin', False),
    }})


@app.route('/api/2fa/verify', methods=['POST'])
def verify_2fa():
    data = request.get_json() or {}
    code = data.get('code', '').strip()
    pending_id = session.get('pending_2fa_user_id')
    if not pending_id:
        return jsonify({'error': 'No pending 2FA session.'}), 400

    user = get_user_by_id(pending_id)
    if not user:
        return jsonify({'error': 'User not found.'}), 404

    stored = user.get('2fa_code')
    expires_str = user.get('2fa_expires')
    if not stored or not expires_str:
        return jsonify({'error': 'No 2FA code found. Log in again.'}), 400
    if datetime.utcnow() > datetime.fromisoformat(expires_str):
        return jsonify({'error': '2FA code expired. Log in again.'}), 400
    if not hmac.compare_digest(code, stored):
        return jsonify({'error': 'Invalid verification code.'}), 401

    users_table().update_item(
        Key={'user_id': user['user_id']},
        UpdateExpression='REMOVE #c, #e',
        ExpressionAttributeNames={'#c': '2fa_code', '#e': '2fa_expires'},
    )
    session.pop('pending_2fa_user_id', None)
    session['user_id'] = user['user_id']
    session['username'] = user['username']
    session['is_admin'] = user.get('is_admin', False)
    return jsonify({'success': True, 'user': {
        'username': user['username'], 'email': user['email'],
        'is_admin': user.get('is_admin', False),
    }})


@app.route('/api/2fa/enroll', methods=['POST'])
@require_auth
def enroll_2fa():
    uid = str(session['user_id'])
    print(f'DEBUG 2FA_ENROLL session: {dict(session)}')
    print(f'DEBUG 2FA_ENROLL user_id type={type(uid).__name__} value={uid!r}')
    logger.info(f'2FA_ENROLL: enabling 2FA for user_id={uid}')
    users_table().update_item(
        Key={'user_id': uid},
        UpdateExpression='SET #en = :t',
        ExpressionAttributeNames={'#en': '2fa_enabled'},
        ExpressionAttributeValues={':t': True},
    )
    logger.info(f'2FA_ENROLL: success for user_id={uid}')
    return jsonify({'success': True})


@app.route('/api/2fa/disable', methods=['POST'])
@require_auth
def disable_2fa():
    uid = str(session['user_id'])
    logger.info(f'2FA_DISABLE: disabling 2FA for user_id={uid}')
    users_table().update_item(
        Key={'user_id': uid},
        UpdateExpression='SET #en = :f',
        ExpressionAttributeNames={'#en': '2fa_enabled'},
        ExpressionAttributeValues={':f': False},
    )
    logger.info(f'2FA_DISABLE: success for user_id={uid}')
    return jsonify({'success': True})


@app.route('/api/me')
def me():
    if 'user_id' not in session:
        return jsonify({'logged_in': False})
    user = get_user_by_id(session['user_id'])
    if not user:
        session.clear()
        return jsonify({'logged_in': False})
    return jsonify({'logged_in': True, 'user': {
        'user_id': user['user_id'],
        'username': user['username'],
        'email': user['email'],
        'is_admin': user.get('is_admin', False),
        'created_at': user.get('created_at'),
        '2fa_enabled': user.get('2fa_enabled', False),
        'age': user.get('age'),
        'weight': user.get('weight'),
        'height': user.get('height'),
        'gender': user.get('gender'),
        'unit_preference': user.get('unit_preference', 'imperial'),
    }})


@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})


# ── Routes: user settings ─────────────────────────────────────────────────────

@app.route('/api/user/username', methods=['PUT'])
@require_auth
def update_username():
    data = request.get_json() or {}
    new_u = data.get('username', '').strip()
    if not valid_username(new_u):
        return jsonify({'error': 'Username must be 3-30 chars (letters, numbers, _ . -)'}), 400
    existing = get_user_by_username(new_u)
    if existing and existing['user_id'] != session['user_id']:
        return jsonify({'error': 'That username is already taken.'}), 409
    users_table().update_item(
        Key={'user_id': str(session['user_id'])},
        UpdateExpression='SET username = :u',
        ExpressionAttributeValues={':u': new_u},
    )
    session['username'] = new_u
    return jsonify({'success': True})


@app.route('/api/user/email', methods=['PUT'])
@require_auth
def update_email():
    data = request.get_json() or {}
    new_e = data.get('email', '').strip().lower()
    if not valid_email(new_e):
        return jsonify({'error': 'Please enter a valid email address.'}), 400
    existing = get_user_by_email(new_e)
    if existing and existing['user_id'] != session['user_id']:
        return jsonify({'error': 'That email is already in use.'}), 409
    users_table().update_item(
        Key={'user_id': str(session['user_id'])},
        UpdateExpression='SET email = :e',
        ExpressionAttributeValues={':e': new_e},
    )
    return jsonify({'success': True})


@app.route('/api/user/metrics', methods=['PUT'])
@require_auth
def update_metrics():
    data = request.get_json() or {}
    uid = str(session['user_id'])
    print(f'DEBUG UPDATE_METRICS session: {dict(session)}')
    print(f'DEBUG UPDATE_METRICS user_id type={type(uid).__name__} value={uid!r}')
    logger.info(f'UPDATE_METRICS: user_id={uid} payload_keys={list(data.keys())}')
    parts, vals, names = [], {}, {}
    if 'age' in data and data['age'] is not None:
        parts.append('#age = :age')
        vals[':age'] = to_dec(data['age'])
        names['#age'] = 'age'
    if 'weight' in data and data['weight'] is not None:
        parts.append('#weight = :weight')
        vals[':weight'] = to_dec(data['weight'])
        names['#weight'] = 'weight'
    if 'height' in data and data['height'] is not None:
        parts.append('#height = :height')
        vals[':height'] = to_dec(data['height'])
        names['#height'] = 'height'
    if 'gender' in data and data['gender']:
        parts.append('#gender = :gender')
        vals[':gender'] = str(data['gender'])
        names['#gender'] = 'gender'
    if 'unit_preference' in data:
        if data['unit_preference'] not in ('imperial', 'metric'):
            return jsonify({'error': 'Invalid unit preference.'}), 400
        parts.append('#unit = :unit')
        vals[':unit'] = str(data['unit_preference'])
        names['#unit'] = 'unit_preference'
    if not parts:
        return jsonify({'error': 'Nothing to update.'}), 400
    logger.info(f'UPDATE_METRICS: updating fields={list(names.values())} for user_id={uid}')
    users_table().update_item(
        Key={'user_id': uid},
        UpdateExpression='SET ' + ', '.join(parts),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=vals,
    )
    logger.info(f'UPDATE_METRICS: success for user_id={uid}')
    return jsonify({'success': True})


# ── Routes: workouts ──────────────────────────────────────────────────────────

@app.route('/api/workouts', methods=['POST'])
@require_auth
def log_workout():
    data = request.get_json() or {}
    for f in ('exercise_name', 'sets', 'reps', 'date'):
        if not data.get(f) and data.get(f) != 0:
            return jsonify({'error': f'Missing field: {f}'}), 400
    workout_id = str(uuid.uuid4())
    item = {
        'workout_id': workout_id,
        'user_id': session['user_id'],
        'exercise_name': str(data['exercise_name']),
        'sets': to_dec(data.get('sets', 0)),
        'reps': to_dec(data.get('reps', 0)),
        'weight': to_dec(data.get('weight', 0)),
        'duration': to_dec(data.get('duration', 0)),
        'date': str(data['date']),
        'created_at': datetime.utcnow().isoformat(),
    }
    workouts_table().put_item(Item=item)
    return jsonify({'success': True, 'workout': item}), 201


@app.route('/api/workouts', methods=['GET'])
@require_auth
def get_workouts():
    r = workouts_table().query(
        IndexName='user_id-index',
        KeyConditionExpression=Key('user_id').eq(session['user_id']),
    )
    items = sorted(r.get('Items', []), key=lambda x: x.get('date', ''), reverse=True)
    return jsonify({'workouts': clean(items)})


@app.route('/api/workouts/<workout_id>', methods=['PUT'])
@require_auth
def update_workout(workout_id):
    r = workouts_table().get_item(Key={'workout_id': workout_id})
    w = r.get('Item')
    if not w:
        return jsonify({'error': 'Workout not found.'}), 404
    if w['user_id'] != session['user_id']:
        return jsonify({'error': 'Unauthorized.'}), 403
    data = request.get_json() or {}
    parts, vals = [], {}
    for f in ('exercise_name', 'sets', 'reps', 'weight', 'duration', 'date'):
        if f in data:
            parts.append(f'{f} = :{f}')
            if f in ('sets', 'reps', 'duration', 'weight'):
                vals[f':{f}'] = to_dec(data[f])
            else:
                vals[f':{f}'] = str(data[f])
    if not parts:
        return jsonify({'error': 'Nothing to update.'}), 400
    workouts_table().update_item(
        Key={'workout_id': workout_id},
        UpdateExpression='SET ' + ', '.join(parts),
        ExpressionAttributeValues=vals,
    )
    return jsonify({'success': True})


@app.route('/api/workouts/<workout_id>', methods=['DELETE'])
@require_auth
def delete_workout(workout_id):
    r = workouts_table().get_item(Key={'workout_id': workout_id})
    w = r.get('Item')
    if not w:
        return jsonify({'error': 'Workout not found.'}), 404
    if w['user_id'] != session['user_id']:
        return jsonify({'error': 'Unauthorized.'}), 403
    workouts_table().delete_item(Key={'workout_id': workout_id})
    return jsonify({'success': True})


# ── Routes: Wger exercise API ─────────────────────────────────────────────────

@app.route('/api/exercises')
def get_exercises():
    r = requests.get(f'{WGER_BASE}/exercise/', params={'format': 'json', 'language': 7, 'limit': 50}, timeout=10)
    return jsonify(r.json())


@app.route('/api/exercises/search')
def search_exercises():
    term = request.args.get('term', '')
    r = requests.get(f'{WGER_BASE}/exercise/search/',
                     params={'term': term, 'language': 'english', 'format': 'json'}, timeout=10)
    return jsonify(r.json())


@app.route('/api/muscles')
def get_muscles():
    r = requests.get(f'{WGER_BASE}/muscle/', params={'format': 'json'}, timeout=10)
    return jsonify(r.json())


@app.route('/api/exercises/by-muscle')
def exercises_by_muscle():
    muscle_id = request.args.get('muscle_id', '')
    r = requests.get(f'{WGER_BASE}/exercise/',
                     params={'format': 'json', 'language': 7, 'muscles': muscle_id, 'limit': 50}, timeout=10)
    return jsonify(r.json())


# ── Routes: AI recommendations ────────────────────────────────────────────────

@app.route('/api/ai/recommendations', methods=['POST'])
@require_auth
def ai_recommendations():
    import anthropic as _anthropic
    user = get_user_by_id(session['user_id'])
    if not user:
        return jsonify({'error': 'User not found.'}), 404

    r = workouts_table().query(
        IndexName='user_id-index',
        KeyConditionExpression=Key('user_id').eq(session['user_id']),
    )
    workouts = sorted(clean(r.get('Items', [])), key=lambda x: x.get('date', ''), reverse=True)[:10]
    if not workouts:
        return jsonify({'error': 'Log at least one workout to get AI recommendations.'}), 400

    unit = user.get('unit_preference', 'imperial')
    wu = 'lbs' if unit == 'imperial' else 'kg'
    hu = 'inches' if unit == 'imperial' else 'cm'
    summary = '\n'.join(
        f"- {w['exercise_name']}: {w['sets']} sets x {w['reps']} reps @ {w['weight']} {wu}, "
        f"{w['duration']} min ({w['date']})"
        for w in workouts
    )
    prompt = (
        f"You are a professional fitness coach. Based on the following user data, "
        f"provide personalized workout recommendations. Be specific, encouraging, and practical. "
        f"Format your response with clear sections.\n\n"
        f"User Profile: Age: {user.get('age', 'unknown')}, "
        f"Weight: {user.get('weight', 'unknown')} {wu}, "
        f"Height: {user.get('height', 'unknown')} {hu}, "
        f"Gender: {user.get('gender', 'unspecified')}\n\n"
        f"Recent Workout History (last 10 workouts):\n{summary}\n\n"
        f"Please provide:\n"
        f"1. An analysis of their current workout pattern (2-3 sentences)\n"
        f"2. 3 specific workout recommendations based on their history and body metrics\n"
        f"3. Suggested improvements to their current routine\n"
        f"4. A motivational note based on their progress"
    )

    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        return jsonify({'error': 'AI service not configured.'}), 503

    client = _anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model='claude-opus-4-7',
        max_tokens=1024,
        messages=[{'role': 'user', 'content': prompt}],
    )
    return jsonify({'success': True, 'recommendations': message.content[0].text})


# ── Routes: admin ─────────────────────────────────────────────────────────────

@app.route('/api/admin/users')
@require_admin
def admin_get_users():
    all_users = clean(users_table().scan().get('Items', []))
    wt = workouts_table()
    result = []
    for u in all_users:
        wr = wt.query(
            IndexName='user_id-index',
            KeyConditionExpression=Key('user_id').eq(u['user_id']),
        )
        u_workouts = clean(wr.get('Items', []))
        result.append({
            'user_id': u['user_id'],
            'username': u.get('username'),
            'email': u.get('email'),
            'is_admin': u.get('is_admin', False),
            'created_at': u.get('created_at'),
            '2fa_enabled': u.get('2fa_enabled', False),
            'age': u.get('age'),
            'weight': u.get('weight'),
            'height': u.get('height'),
            'gender': u.get('gender'),
            'unit_preference': u.get('unit_preference', 'imperial'),
            'workouts': sorted(u_workouts, key=lambda x: x.get('date', ''), reverse=True),
        })
    return jsonify({'users': result})


@app.route('/api/admin/users/<user_id>/toggle-2fa', methods=['PUT'])
@require_admin
def admin_toggle_2fa(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({'error': 'User not found.'}), 404
    new_val = not user.get('2fa_enabled', False)
    users_table().update_item(
        Key={'user_id': str(user_id)},
        UpdateExpression='SET #en = :v',
        ExpressionAttributeNames={'#en': '2fa_enabled'},
        ExpressionAttributeValues={':v': new_val},
    )
    return jsonify({'success': True, '2fa_enabled': new_val})


@app.route('/api/admin/users/<user_id>/email', methods=['PUT'])
@require_admin
def admin_update_email(user_id):
    data = request.get_json() or {}
    new_e = data.get('email', '').strip().lower()
    if not valid_email(new_e):
        return jsonify({'error': 'Invalid email address.'}), 400
    existing = get_user_by_email(new_e)
    if existing and existing['user_id'] != user_id:
        return jsonify({'error': 'Email already in use.'}), 409
    users_table().update_item(
        Key={'user_id': str(user_id)},
        UpdateExpression='SET email = :e',
        ExpressionAttributeValues={':e': new_e},
    )
    return jsonify({'success': True})


@app.route('/api/admin/users/<user_id>/username', methods=['PUT'])
@require_admin
def admin_update_username(user_id):
    data = request.get_json() or {}
    new_u = data.get('username', '').strip()
    if not valid_username(new_u):
        return jsonify({'error': 'Invalid username.'}), 400
    existing = get_user_by_username(new_u)
    if existing and existing['user_id'] != user_id:
        return jsonify({'error': 'Username already taken.'}), 409
    users_table().update_item(
        Key={'user_id': str(user_id)},
        UpdateExpression='SET username = :u',
        ExpressionAttributeValues={':u': new_u},
    )
    return jsonify({'success': True})


@app.route('/api/admin/users/<user_id>/metrics', methods=['PUT'])
@require_admin
def admin_update_metrics(user_id):
    data = request.get_json() or {}
    parts, vals = [], {}
    for f in ('age', 'weight', 'height', 'gender', 'unit_preference'):
        if f in data:
            parts.append(f'{f} = :{f}')
            vals[f':{f}'] = to_dec(data[f]) if f in ('age', 'weight', 'height') else data[f]
    if not parts:
        return jsonify({'error': 'Nothing to update.'}), 400
    users_table().update_item(
        Key={'user_id': str(user_id)},
        UpdateExpression='SET ' + ', '.join(parts),
        ExpressionAttributeValues=vals,
    )
    return jsonify({'success': True})


@app.route('/api/admin/workouts/<workout_id>', methods=['PUT'])
@require_admin
def admin_update_workout(workout_id):
    data = request.get_json() or {}
    parts, vals = [], {}
    for f in ('exercise_name', 'sets', 'reps', 'weight', 'duration', 'date'):
        if f in data:
            parts.append(f'{f} = :{f}')
            if f in ('sets', 'reps', 'duration', 'weight'):
                vals[f':{f}'] = to_dec(data[f])
            else:
                vals[f':{f}'] = str(data[f])
    if not parts:
        return jsonify({'error': 'Nothing to update.'}), 400
    workouts_table().update_item(
        Key={'workout_id': workout_id},
        UpdateExpression='SET ' + ', '.join(parts),
        ExpressionAttributeValues=vals,
    )
    return jsonify({'success': True})


@app.route('/api/admin/workouts/<workout_id>', methods=['DELETE'])
@require_admin
def admin_delete_workout(workout_id):
    workouts_table().delete_item(Key={'workout_id': workout_id})
    return jsonify({'success': True})


# ── Security headers ──────────────────────────────────────────────────────────

@app.after_request
def security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    return response


if __name__ == '__main__':
    init_db()
    app.run(host='0.0.0.0', port=5000, debug=False)
