const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const express = require('express');
const MClient = require("../client/mclient");
const LogHelper = require("../loghelper");
const MData = require('../multplayerdata/mdata');
const GameServer = require('./gameserver');
const conf = require('../conf/conf');

class MainServer {
	gameservers;
	#clients;
	#host;
	mdata;
	#frontendPath;
	#gameNames;
	#app;
	constructor (hostArgs) {
		this.#clients = {};
		this.gameservers = {};
		this.mdata = new MData();
		this.#frontendPath = this.#resolveFrontendPath(hostArgs);
		this.#gameNames = new Set();
		this.#refreshGameList();
		this.#app = this.#buildExpressApp();

		if(hostArgs.https)
		{
			const cert = fs.readFileSync(hostArgs.https.certpath);
			const key = fs.readFileSync(hostArgs.https.keypath);
			const httpsServer = https.createServer({cert, key}, this.#app).listen(hostArgs.port);
			this.#host = new WebSocket.Server({server: httpsServer});
		}
		else
		{
			const httpServer = http.createServer(this.#app).listen(hostArgs.port);
			this.#host = new WebSocket.Server({server: httpServer});
		}
		this.#host.on('connection', (client, request)=>this.onConnect(client, request));
		LogHelper.log(`Running server at port ${hostArgs.port}`)
		LogHelper.log(`Serving frontend from ${this.#frontendPath}`)
	}

	#resolveFrontendPath(hostArgs) {
		if (hostArgs.frontendPath) {
			return path.resolve(hostArgs.frontendPath);
		}
		return path.resolve(__dirname, '../../frontend');
	}

	#refreshGameList() {
		const gamesDir = path.join(this.#frontendPath, 'games');
		const names = new Set();
		try {
			if (fs.existsSync(gamesDir)) {
				for (const entry of fs.readdirSync(gamesDir, { withFileTypes: true })) {
					if (entry.isDirectory()) {
						names.add(entry.name);
					}
				}
			}
		} catch (e) {
			LogHelper.warn(`Could not read games directory: ${e.message}`);
		}
		this.#gameNames = names;
	}

	#isValidGame(name) {
		if (!name) return false;
		// Re-scan on cache miss so newly added games are picked up dynamically.
		if (!this.#gameNames.has(name)) {
			this.#refreshGameList();
		}
		return this.#gameNames.has(name);
	}

	#getTotalPlayers() {
		let count = 0;
		for(let name in this.gameservers) {
			count += this.gameservers[name].clientsCount;
		}
		return count;
	}

	#getGamePlayerCounts() {
		let counts = {};
		for(let name in this.gameservers) {
			counts[name] = this.gameservers[name].clientsCount;
		}
		return counts;
	}

	#buildExpressApp() {
		const app = express();

		app.get('/api/players', (req, res) => {
			const game = req.query.game;
			let response = {
				total: this.getTotalPlayers()
			};
			if(game) {
				const gs = this.gameservers[game];
				response.game = game;
				response.count = gs ? gs.clientsCount : 0;
			} else {
				response.games = this.getGamePlayerCounts();
			}
			res.json(response);
		});

		// Dedicated game page: /<game>/ or /<game>
		app.get(/^\/([^/]+)\/?$/, (req, res, next) => {
			const gameName = decodeURIComponent(req.params[0]);
			// Let express.static handle real files (e.g. /easyrpg-player.html).
			if (path.extname(gameName)) {
				return next();
			}
			if (this.#isValidGame(gameName)) {
				return res.sendFile(path.join(this.#frontendPath, 'game.html'));
			}
			res.status(404).type('text/plain').send('Game not found');
		});

		// Static files: express.static handles index.html at / and everything else.
		app.use(express.static(this.#frontendPath));

		return app;
	}

	getGameServer(name) {
		if(!this.gameservers[name])
			this.gameservers[name] = new GameServer(name, this);

		return this.gameservers[name];
	}

	onConnect(client, request) {
		let mclient = new MClient(client, request, this);
		this.#clients[client.connectionId] = mclient;
		if(conf.echo) mclient.echoId();
		mclient.sendMDataPackets(this.mdata.getFull());
		client.onmessage = (req)=>this.onMessage(mclient, req);
		client.on('close', ()=>this.onClose(mclient));
	}

	onMessage(client, req) {
		let data = req.data;
		if(typeof data === "string") return;
		let type = data.readUint8(0);
		switch(type) {
			case 0:
			    this.onMapPacket(client, data)
			break;

			case 1:
			    if(client.map)
			        client.map.processPacket(client, data.slice(1));
			break;
			default:
			    
			break;
		}
	}

	onMapPacket(client, data) {
		if(data.length == 3) {
			let mapId = data.readUInt16LE(1);
			if(!client.map || (client.map.id != mapId))
			    client.map = client.game.getMap(mapId);
			else
			    LogHelper.warn("Client tries to join the same map that it is already in");
		}
		else
			LogHelper.warn("Invalid map change packet");
	}

	onClose(client) {
		client.game.disconnectClient(client);
		if(!client.game.clientsCount) delete this.gameservers[client.game.name];
		LogHelper.log(`Client ${client.connectionId} closed connection.`);
	}

	broadcastMData(mdataSlots) {
		for(let c in this.#clients) {
			this.#clients[c].sendMDataPackets(mdataSlots);
		}
	}
}

module.exports = MainServer;