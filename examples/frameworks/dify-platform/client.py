"""Dify 플랫폼 API 클라이언트. 로컬 SDK나 Dify 자체를 대체하지 않습니다."""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

def configuration():
    if Path('.env').exists():
        for line in Path('.env').read_text(encoding='utf-8-sig').splitlines():
            key, sep, value = line.partition('=')
            if sep and key.strip() in ('DIFY_API_BASE', 'DIFY_API_KEY', 'DIFY_USER'):
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    missing = [k for k in ('DIFY_API_BASE', 'DIFY_API_KEY', 'DIFY_USER') if not os.environ.get(k, '').strip()]
    return {'ready': not missing, 'missing': missing, 'providerVerified': False}

def validate_base(base):
    url = urlparse(base)
    if not url.netloc or url.username or url.password or url.query or url.fragment or (url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1'))):
        raise ValueError('안전한 Dify API 주소가 필요합니다.')
    return base.rstrip('/')

def parse_result(body):
    data = body.get('data', {})
    if data.get('status') != 'succeeded':
        raise ValueError('Dify 워크플로가 성공하지 않았습니다.')
    result = data.get('outputs', {}).get('result')
    if isinstance(result, str):
        result = json.loads(result)
    if not isinstance(result, dict) or result.get('category') not in ('billing', 'account', 'technical', 'other') or result.get('urgency') not in ('normal', 'high') or not isinstance(result.get('summary'), str) or not result['summary'].strip() or len(result['summary']) > 1000:
        raise ValueError('Dify 출력 스키마 오류')
    return {'workflowRunId': body.get('workflow_run_id'), 'result': result}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('자격 증명 보호를 위해 리디렉션을 거절했습니다.')

def run_ticket(query, config, opener=None):
    if not isinstance(query, str) or not query.strip() or len(query) > 4000:
        raise ValueError('입력 길이 오류')
    if not config.get('key', '').strip() or not config.get('user', '').strip() or len(config['user']) > 128:
        raise ValueError('Dify 키 또는 사용자 식별자 미설정')
    body = json.dumps({'inputs': {'query': query}, 'response_mode': 'blocking', 'user': config['user']}).encode('utf-8')
    request = Request(validate_base(config['base']) + '/workflows/run', data=body, headers={'Authorization': 'Bearer ' + config['key'], 'Content-Type': 'application/json'}, method='POST')
    with (opener or build_opener(NoRedirect())).open(request, timeout=90) as response:
        return parse_result(json.loads(response.read(1_000_001)))

if __name__ == '__main__':
    config = configuration()
    if len(sys.argv) > 1 and sys.argv[1] == 'check':
        print(json.dumps(config, ensure_ascii=False))
    elif not config['ready']:
        print('미설정: ' + ', '.join(config['missing']), file=sys.stderr)
        raise SystemExit(2)
    else:
        try:
            if sys.argv[1] != 'run':
                raise ValueError('명령 오류')
            print(json.dumps(run_ticket(' '.join(sys.argv[2:]), {'base': os.environ['DIFY_API_BASE'], 'key': os.environ['DIFY_API_KEY'], 'user': os.environ['DIFY_USER']}), ensure_ascii=False))
        except Exception:
            print('실행 실패: Dify 발행·모델·API 설정 또는 출력 형식을 확인하세요. 자동 재시도하지 않았습니다.', file=sys.stderr)
            raise SystemExit(1)
