/**
 * Minimal ZIP writer (STORE method, no compression) for the session-log
 * download. Self-contained so the web host needs no archive dependency;
 * output is a standards-compliant archive (local headers, central directory,
 * end-of-central-directory record) readable by any unzip tool.
 */

/** CRC-32 (IEEE) lookup table, built once. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
	return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time bit packing for entry headers. */
function dosDateTime(now: Date): { time: number; date: number } {
	return {
		time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
		date: (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
	};
}

/** One stored archive member. */
export interface ZipEntry {
	/** Archive path (flat names suffice for session logs). */
	name: string;
	data: Uint8Array;
}

/**
 * Build a ZIP archive over the entries. Throws when an entry count or size
 * exceeds the classic format's 16/32-bit limits (session logs never do).
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder();
	const { time, date } = dosDateTime(new Date());
	const body: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const crc = crc32(entry.data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true); // local file header signature
		local.setUint16(4, 20, true); // version needed
		local.setUint16(6, 0, true); // flags
		local.setUint16(8, 0, true); // method: STORE
		local.setUint16(10, time, true);
		local.setUint16(12, date, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, entry.data.length, true); // compressed size
		local.setUint32(22, entry.data.length, true); // uncompressed size
		local.setUint16(26, name.length, true);
		local.setUint16(28, 0, true); // extra length
		body.push(new Uint8Array(local.buffer), name, entry.data);

		const record = new DataView(new ArrayBuffer(46));
		record.setUint32(0, 0x02014b52, true); // central directory signature
		record.setUint16(4, 20, true); // version made by
		record.setUint16(6, 20, true); // version needed
		record.setUint16(8, 0, true); // flags
		record.setUint16(10, 0, true); // method: STORE
		record.setUint16(12, time, true);
		record.setUint16(14, date, true);
		record.setUint32(16, crc, true);
		record.setUint32(20, entry.data.length, true);
		record.setUint32(24, entry.data.length, true);
		record.setUint16(28, name.length, true);
		record.setUint32(42, offset, true); // local header offset
		central.push(new Uint8Array(record.buffer), name);
		offset += 30 + name.length + entry.data.length;
	}
	if (entries.length > 0xffff || offset > 0xffffffff) {
		throw new Error("omp-web: zip64 is not supported by this writer");
	}
	let centralSize = 0;
	for (const chunk of central) centralSize += chunk.length;
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true); // end of central directory signature
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, offset, true);
	const total = offset + centralSize + 22;
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of [...body, ...central, new Uint8Array(end.buffer)]) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}
