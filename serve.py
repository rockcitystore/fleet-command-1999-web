#!/usr/bin/env python3
"""Static server with no-cache headers for local development."""
import http.server
import socketserver
import os

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    PORT = int(os.environ.get('PORT', '8137'))
    with socketserver.TCPServer(('0.0.0.0', PORT), NoCacheHandler) as httpd:
        print(f'Serving at http://0.0.0.0:{PORT}/')
        httpd.serve_forever()
