"""Headless end-to-end test: serves the app, intercepts Sleeper/GitHub calls with fixtures, screenshots each tab."""
import json, re, sys, threading, http.server, socketserver, os, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FX = os.path.join(ROOT, 'test', 'fx')
DP = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dp'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/shots'
os.makedirs(OUT, exist_ok=True)

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = socketserver.TCPServer(('127.0.0.1', 0), Handler); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

def fx(name): return open(os.path.join(FX, name)).read()
def sleeper(route):
    u = route.request.url.split('/v1/')[-1].split('?')[0]
    m = {
        'state/nfl': 'state.json', 'players/nfl': 'players.json', 'players/nfl/trending/add': 'trending.json',
    }
    name = m.get(u)
    if not name:
        if re.match(r'league/\d+$', u): name = 'league.json'
        elif u.endswith('/users'): name = 'users.json'
        elif u.endswith('/rosters'): name = 'rosters.json'
        elif u.endswith('/traded_picks'): name = 'traded.json'
        elif u.endswith('/drafts'): name = 'drafts.json'
        elif '/matchups/' in u: name = 'matchups.json'
        elif u.startswith('user/'): name = 'userleagues.json'
        elif re.match(r'stats/nfl/regular/(\d+)/(\d+)$', u):
            s, w = re.match(r'stats/nfl/regular/(\d+)/(\d+)$', u).groups(); name = f'stats-{s}-{w}.json'
        elif re.match(r'stats/nfl/regular/(\d+)$', u): name = f'stats-{u.split("/")[-1]}.json'
        elif u.startswith('projections/'): name = 'proj-2026-12.json'
    if name and os.path.exists(os.path.join(FX, name)):
        return route.fulfill(status=200, body=fx(name), headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})
    route.fulfill(status=404, body='{}')
def gh(route):
    f = route.request.url.split('/')[-1]
    route.fulfill(status=200, body=open(os.path.join(DP, f)).read(), headers={'access-control-allow-origin': '*'})

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for label, vp in [('mobile', {'width': 390, 'height': 844}), ('desktop', {'width': 1280, 'height': 900})]:
        pg = b.new_page(viewport=vp)
        pg.on('console', lambda m: m.type in ('error', 'warning') and errors.append(m.text))
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.route('https://api.sleeper.app/**', sleeper)
        pg.route('https://api.sleeper.com/**', lambda r: r.fulfill(status=404, body='[]'))
        pg.route('https://raw.githubusercontent.com/**', gh)
        pg.goto(f'http://127.0.0.1:{port}/index.html')
        pg.wait_for_selector('table', timeout=30000)
        pg.wait_for_timeout(1500)
        for tab in ['teams', 'trade', 'draft', 'lineup', 'waivers']:
            pg.click(f'nav button[data-tab="{tab}"]'); pg.wait_for_timeout(700)
            if tab == 'teams': pg.click('tr[data-team]'); pg.wait_for_timeout(300)
            if tab == 'trade':
                pg.evaluate('window.scrollTo(0,0)'); pg.screenshot(path=f'{OUT}/{label}-finder.png', full_page=(label == 'desktop'))
                print('finder:', pg.inner_text('#view')[:900])
                pg.click('[data-tsub="edges"]'); pg.wait_for_timeout(300); pg.screenshot(path=f'{OUT}/{label}-edges.png', full_page=(label == 'desktop'))
                print('edges:', pg.inner_text('#view')[:600])
                pg.click('[data-tsub="acq"]'); pg.wait_for_timeout(600); pg.screenshot(path=f'{OUT}/{label}-acq-wr.png', full_page=(label == 'desktop'))
                print('acq:', pg.inner_text('#view')[:700])
                pg.click('[data-acq="kind:pick"]'); pg.wait_for_timeout(600); pg.screenshot(path=f'{OUT}/{label}-acq-pick.png', full_page=(label == 'desktop'))
                print('acqpick:', pg.inner_text('#view')[:500])
                pg.click('[data-loadacq="0"]'); pg.wait_for_timeout(300)
                pg.click('[data-tsub="find"]'); pg.wait_for_timeout(300)
                pg.click('[data-loadtrade="0"]'); pg.wait_for_timeout(400)
                pg.screenshot(path=f'{OUT}/{label}-loaded.png')
                pg.click('[data-tsub="calc"]'); pg.wait_for_timeout(200)
                pg.locator('input[data-pick="a"]').nth(0).click(); pg.wait_for_timeout(200)
                pg.locator('input[data-pick="b"]').nth(2).click(); pg.wait_for_timeout(200)
                pg.locator('input[data-pick="b"]').nth(5).click(); pg.wait_for_timeout(300)
            pg.evaluate('window.scrollTo(0,0)'); pg.screenshot(path=f'{OUT}/{label}-{tab}.png', full_page=(label == 'desktop'))
            print(label, tab, 'ok', len(pg.inner_text('#view')))
        if label == 'desktop':
            print(pg.inner_text('#view')[:1500])
        pg.close()
    b.close()
print('ERRORS:', errors[:10])
