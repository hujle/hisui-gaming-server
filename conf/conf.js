function loadJson(filePath) {
	try {
		return require(filePath);
	} catch (e) {
		if (e.code === 'MODULE_NOT_FOUND') {
			return {};
		}
		throw e;
	}
}

function deepMerge(target, source) {
	for (const key in source) {
		if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
			if (!target[key] || typeof target[key] !== 'object') {
				target[key] = {};
			}
			deepMerge(target[key], source[key]);
		} else {
			target[key] = source[key];
		}
	}
	return target;
}

module.exports = deepMerge(
	deepMerge(
		loadJson("./default.json"),
		loadJson("./conf.json")
	),
	loadJson("./conf.local.json")
);