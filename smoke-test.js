/**
 * Smoke test — uruchamia serwer, sprawdza GET /, zamyka.
 * Zwraca exit code 0 jeśli OK, 1 jeśli błąd.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.SMOKE_PORT || 3099;
const env = { ...process.env, PORT };

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env, cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe']
});

let serverOut = '';
server.stdout.on('data', d => { serverOut += d.toString(); });
server.stderr.on('data', d => { serverOut += d.toString(); });

let actualPort = PORT;
function tryRequest(port, attempt = 0) {
    const req = http.get(`http://localhost:${port}/`, (res) => {
        const ok = res.statusCode === 200;
        // also load modules to check require'ability
        let modulesOk = true;
        const modules = [
            './parser/tmdl-parser', './parser/model-loader',
            './comparison/engine', './comparison/extractor',
            './deployment/deployer', './deployment/tmdl-writer'
        ];
        for (const m of modules) {
            try { require(path.join(__dirname, m)); }
            catch (e) { console.error(`MODULE FAIL ${m}: ${e.message}`); modulesOk = false; }
        }
        server.kill();
        if (ok && modulesOk) {
            console.log(`SMOKE OK status=${res.statusCode} port=${port}`);
            process.exit(0);
        } else {
            console.error(`SMOKE FAIL status=${res.statusCode} modulesOk=${modulesOk}`);
            console.error(serverOut);
            process.exit(1);
        }
    });
    req.on('error', (err) => {
        if (attempt < 10) {
            setTimeout(() => tryRequest(port, attempt + 1), 500);
        } else {
            // maybe port hopped
            const portHop = serverOut.match(/listening on http:\/\/localhost:(\d+)/i)
                         || serverOut.match(/localhost:(\d+)/);
            if (portHop && portHop[1] !== String(port)) {
                tryRequest(portHop[1], 0);
            } else {
                console.error(`SMOKE FAIL connect: ${err.message}`);
                console.error(serverOut);
                server.kill();
                process.exit(1);
            }
        }
    });
}

setTimeout(() => tryRequest(PORT), 1500);

setTimeout(() => {
    console.error('SMOKE TIMEOUT');
    console.error(serverOut);
    server.kill();
    process.exit(1);
}, 15000);
