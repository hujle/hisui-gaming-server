const MData = require('../multplayerdata/mdata');
const BufferBuilder = require('../bufferbuilder');
const config = require('../conf/conf');
const LogHelper = require('../loghelper');
const { validateSession } = require('../server/database');

let lastConnectionId = 0;

const PacketType = {
	connect: 0,
	inmap: 1,
	disconnect: 2,
	mdata: 3,
	id: 4
}

class MClient {
	#wsConnection;
	#connectionId;
	#accountId;
	#accountType;
	#username;
	#guestUuid;
	#game;
	#map;
	#server;
	mdata;

	constructor(wsConnection, request, server) {
		this.#wsConnection = wsConnection;
		this.#server = server;
		this.#connectionId = lastConnectionId++;
		
		const url = new URL(request.url, "http://localhost");
		const gameServerName = url.searchParams.get("game");
		
		const cookieHeader = request.headers.cookie || '';
		const tokenMatch = cookieHeader.match(/auth_token=([^;]+)/);
		const token = tokenMatch ? tokenMatch[1] : null;
		
		let session = null;
		if (token) {
			session = validateSession(token);
		}
		
		if (session) {
			this.#accountId = session.accountId;
			this.#accountType = session.accountType;
			this.#username = session.username;
			this.#guestUuid = session.guestUuid;
			LogHelper.log(`Authenticated client connected: accountId=${this.#accountId}, type=${this.#accountType}, game="${gameServerName}"`);
		} else {
			this.#accountId = null;
			this.#accountType = 'anonymous';
			this.#username = `Guest${this.#connectionId}`;
			this.#guestUuid = null;
			LogHelper.log(`Anonymous client connected: connectionId=${this.#connectionId}, game="${gameServerName}"`);
		}
		
		this.#game = server.getGameServer(gameServerName);
		this.#game.connectClient(this);
		this.mdata = new MData();
	}

	get map() { return this.#map; }
	set map(map) { 
		if(this.#map) {
			this.#map.disconnectClient(this);
		}
		this.#map = map; 
		map.connectClient(this);
	}

	get game() { return this.#game; }

	get server() { return this.#server; }

	get connectionId() { return this.#connectionId; }

	get accountId() { return this.#accountId; }

	get accountType() { return this.#accountType; }

	get username() { return this.#username; }

	get guestUuid() { return this.#guestUuid; }

	get ws() { return this.#wsConnection; }

	sendConnectPacket(client) {
		let buffer = new BufferBuilder();
		buffer.addUint8Array([PacketType.connect]);
		const accountId = client.accountId ? BigInt(client.accountId) : BigInt(0);
		buffer.addUint64Array([accountId]);
		this.ws.send(buffer.get());
		LogHelper.log(`Outgoing connect: client ${this.connectionId}, accountId=${accountId}, data: ${buffer.get().toString("hex")}`)
	}

	sendInMapPacket(client) {
		let buffer = new BufferBuilder();
		buffer.addUint8Array([PacketType.inmap]);
		const accountId = client.accountId ? BigInt(client.accountId) : BigInt(0);
		buffer.addUint64Array([accountId]);
		this.ws.send(buffer.get());
		LogHelper.log(`Outgoing in map: client ${this.connectionId}, accountId=${accountId}, data: ${buffer.get().toString("hex")}`)
	}

	sendMDataPacket(mdataSlot) {
		if((mdataSlot.owner.connectionId == this.#connectionId) && !config.echo) return;
		let buffer = new BufferBuilder();
		buffer.addUint8Array([PacketType.mdata, mdataSlot.scope]);
		const ownerAccountId = mdataSlot.owner.accountId ? BigInt(mdataSlot.owner.accountId) : BigInt(0);
		buffer.addUint64Array([ownerAccountId]);
		buffer.addUint32Array([this.#map ? this.#map.id : 0]);
		buffer.addUint16Array([mdataSlot.slot]);
		buffer.addBuffer(mdataSlot.blob);
		this.ws.send(buffer.get());
	}
	
	echoId() 
	{
		let buffer = new BufferBuilder();
		buffer.addUint8Array([PacketType.id]);
		const accountId = this.accountId ? BigInt(this.accountId) : BigInt(this.connectionId);
		buffer.addUint64Array([accountId]);
		this.ws.send(buffer.get());
	}

	sendMDataPackets(mdataSlots) {
		if(Array.isArray(mdataSlots)) {
			for(let m of mdataSlots) {
				if(m)
					this.sendMDataPacket(m);
			}
		} else {
			this.sendMDataPacket(mdataSlots);
		}
	}

	sendDisconnectPacket(client) {
		let buffer = new BufferBuilder();
		buffer.addUint8Array([PacketType.disconnect]);
		const accountId = client.accountId ? BigInt(client.accountId) : BigInt(0);
		buffer.addUint64Array([accountId]);
		this.ws.send(buffer.get());
		LogHelper.log(`Outgoing disconnect: client ${this.connectionId}, accountId=${accountId}, data: ${buffer.get().toString("hex")}`)
	}
}

module.exports = MClient;