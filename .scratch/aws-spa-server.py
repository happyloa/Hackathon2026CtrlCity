from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
class SPA(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(Path('app/dist').resolve()), **kwargs)
    def do_GET(self):
        if '.' not in self.path.split('?')[0].split('/')[-1]: self.path = '/index.html'
        super().do_GET()
ThreadingHTTPServer(('127.0.0.1', 4174), SPA).serve_forever()
