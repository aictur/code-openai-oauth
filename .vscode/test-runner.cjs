const path = require('node:path');
const Mocha = require('mocha');

async function run() {
	const mocha = new Mocha({ ui: 'tdd', color: true });
	mocha.addFile(path.resolve(__dirname, '../out/test/extension.test.js'));
	await mocha.loadFilesAsync();
	return new Promise((resolve, reject) => {
		mocha.run(failures => failures ? reject(new Error(`${failures} tests failed`)) : resolve());
	});
}

module.exports = { run };