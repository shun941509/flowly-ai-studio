"""Real HTTP transport construction with injected sockets, no DNS/network or credentials."""
import io
import json
import ssl
import unittest
from unittest.mock import patch

from test_export_python import runner
from test_export_ops import ops


class ResponseSocket:
    def __init__(self):
        body = b'{"result":{"ok":true}}'
        self.response = b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body
        self.sent = bytearray()
        self.closed = False

    def sendall(self, data):
        self.sent.extend(data)

    def makefile(self, *_args, **_kwargs):
        return io.BytesIO(self.response)

    def settimeout(self, _timeout):
        pass

    def setsockopt(self, *_args):
        pass

    def close(self):
        self.closed = True

    def shutdown(self, _how):
        self.close()


class InternalEndpointTests(unittest.TestCase):
    def exercise(self, transport, endpoint, target, https):
        sock = ResponseSocket()
        contexts = []

        def wrap(context, raw, **kwargs):
            self.assertIs(raw, sock)
            self.assertEqual(kwargs['server_hostname'], 'mcp.internal')
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            contexts.append(context)
            return raw

        port = target[1]
        with patch.object(runner.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.8', port))]), patch.object(runner.socket, 'create_connection', return_value=sock) as connect, patch.object(ssl.SSLContext, 'wrap_socket', new=wrap):
            if transport == 'runtime':
                result, _ = runner.Http().post(endpoint, {'query': 'test'}, {}, 2000)
            else:
                result, _ = ops.ProbeTransport().post(endpoint, {'query': 'test'}, {})
        self.assertEqual(result, {'result': {'ok': True}})
        self.assertEqual(connect.call_args.args[0], target)
        self.assertEqual(len(contexts), 1 if https else 0)
        wire = bytes(sock.sent).decode('utf-8')
        self.assertIn('POST /mcp HTTP/1.1', wire)
        self.assertIn(f'Host: mcp.internal:{port}', wire)
        self.assertEqual(json.loads(wire.split('\r\n\r\n', 1)[1]), {'query': 'test'})
        self.assertTrue(sock.closed)

    def test_runtime_uses_plain_http_for_internal_custom_port(self):
        self.exercise('runtime', 'http://mcp.internal:8080/mcp', ('mcp.internal', 8080), False)

    def test_runtime_uses_verified_tls_for_internal_custom_port(self):
        self.exercise('runtime', 'https://mcp.internal:8443/mcp', ('mcp.internal', 8443), True)

    def test_probe_uses_private_resolved_address_and_original_http_host(self):
        self.exercise('probe', 'http://mcp.internal:8080/mcp', ('10.0.0.8', 8080), False)

    def test_probe_pins_private_address_with_verified_tls_and_original_sni(self):
        self.exercise('probe', 'https://mcp.internal:8443/mcp', ('10.0.0.8', 8443), True)

    def test_https_certificate_failure_is_not_retried_as_http(self):
        for transport in ('runtime', 'probe'):
            sock = ResponseSocket()
            with self.subTest(transport=transport), patch.object(runner.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.8', 8443))]), patch.object(runner.socket, 'create_connection', return_value=sock) as connect, patch.object(ssl.SSLContext, 'wrap_socket', side_effect=ssl.SSLCertVerificationError('untrusted certificate')):
                with self.assertRaises((runner.Fault, ops.OperationsFault)):
                    if transport == 'runtime':
                        runner.Http().post('https://mcp.internal:8443/mcp', {}, {}, 2000)
                    else:
                        ops.ProbeTransport().post('https://mcp.internal:8443/mcp', {}, {})
            self.assertEqual(connect.call_count, 1)
            self.assertEqual(bytes(sock.sent), b'')


if __name__ == '__main__':
    unittest.main()
