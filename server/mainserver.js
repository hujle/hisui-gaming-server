const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const url = require('url');
const MClient = require("../client/mclient");
const LogHelper = require("../loghelper");
const MData = require('../multplayerdata/mdata');
const GameServer = require('./gameserver');
const conf = require('../conf/conf');
const https = require('https');

class MainServer {
	gameservers;
	#clients;
	#host;
	mdata;
	constructor (hostArgs) {
		this.#clients = {};
		this.gameservers = {};
		this.mdata = new MData();

		if(hostArgs.https)
		{
			const cert = fs.readFileSync(hostArgs.https.certpath);
			const key = fs.readFileSync(hostArgs.https.keypath);
			const httpsServer = https.createServer({cert, key}, (req, res)=>this.onHttpRequest(req, res)).listen(hostArgs.port);
			this.#host = new WebSocket.Server({server: httpsServer});
		}
		else
		{
			const httpServer = http.createServer((req, res)=>this.onHttpRequest(req, res)).listen(hostArgs.port);
			this.#host = new WebSocket.Server({server: httpServer});
		}
		this.#host.on('connection', (client, request)=>this.onConnect(client, request));
		LogHelper.log(`Running server at port ${hostArgs.port}`)
	}

	getGameServer(name) {
		if(!this.gameservers[name])
			this.gameservers[name] = new GameServer(name, this);

		return this.gameservers[name];
	}

	getTotalPlayers() {
		let count = 0;
		for(let name in this.gameservers) {
			count += this.gameservers[name].clientsCount;
		}
		return count;
	}

	getGamePlayerCounts() {
		let counts = {};
		for(let name in this.gameservers) {
			counts[name] = this.gameservers[name].clientsCount;
		}
		return counts;
	}

	onHttpRequest(req, res) {
		let parsedUrl;
		try {
			parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
		} catch(e) {
			parsedUrl = url.parse(req.url, true);
		}
		const pathname = parsedUrl.pathname;

		if(pathname === '/api/players') {
			const game = parsedUrl.searchParams.get('game');
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
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*'
			});
			res.end(JSON.stringify(response));
			return;
		}

		res.writeHead(404, {'Content-Type': 'text/plain'});
		res.end('Not found');
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