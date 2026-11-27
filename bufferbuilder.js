class BufferBuilder {
	#bufferList;
	constructor() {
		this.#bufferList = [];
	}

	addString(str) {
		this.#bufferList.push(Buffer.concat([Buffer.from(str, 'base64'), Uint8Array.of(0)]));
	}

	addUintArray(uintArray) {
		this.#bufferList.push(new Uint8Array(uintArray.buffer, uintArray.byteOffset, uintArray.byteLength));
	}

	addUint8Array(uint8list) {
		this.addUintArray(new Uint8Array(uint8list));
	}

	addUint16Array(uint16list) {
		this.addUintArray(new Uint16Array(uint16list));
	}

	addUint32Array(uint32list) {
		this.addUintArray(new Uint32Array(uint32list));
	}

	addUint64Array(uint64list) {
		for (const val of uint64list) {
			const buf = Buffer.alloc(8);
			buf.writeBigUInt64LE(BigInt(val));
			this.#bufferList.push(buf);
		}
	}

	addBuffer(buffer) {
		this.#bufferList.push(buffer);
	}

	get() {
		return Buffer.concat(this.#bufferList);
	}
}

module.exports = BufferBuilder;