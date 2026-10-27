const assert = require('node:assert/strict');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { Sequelize } = require('sequelize');
const run = promisify(execFile);

test('MSSQL migrations, seed data and suggestions query work together', {
  skip: !process.env.TEST_SQLSERVER_URL,
  timeout: 180000
}, async () => {
  const url = new URL(process.env.TEST_SQLSERVER_URL);
  assert.equal(url.hostname, '127.0.0.1', 'integration test must use the disposable local service');
  const database = 'suggestions_dependency_test';
  url.pathname = '/master';
  const admin = new Sequelize(url.toString(), {
    dialect: 'mssql', logging: false,
    dialectOptions: { options: { encrypt: false } }
  });
  let connected = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    try { await admin.authenticate(); connected = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
  assert.ok(connected, 'SQL Server service did not become ready');
  let models;
  try {
    await admin.query(`CREATE DATABASE [${database}]`);
    const local = new Sequelize(database, decodeURIComponent(url.username), decodeURIComponent(url.password), {
      ...require('../data/config/config.json').local,
      port: Number(url.port), logging: false
    });
    try { await local.authenticate(); } finally { await local.close(); }
    url.pathname = `/${database}`;
    process.env.NODE_ENV = 'docker';
    process.env.SUGGESTIONS_DATABASE_URL = url.toString();
    const cli = require.resolve('sequelize-cli/lib/sequelize');
    await run(process.execPath, [cli, 'db:migrate', '--env', 'docker'], { env: process.env });
    await run(process.execPath, [cli, 'db:seed:all', '--env', 'docker'], { env: process.env });
    models = require('../data/models');
    const results = await require('../queries/suggestionsQuery').get({ latitude: 47.6, longitude: -122.3 }, 3);
    assert.equal(results.length, 3);
    assert.ok(results.every(item => typeof item.name === 'string' && Number.isFinite(item.distance)));
    assert.ok(results[0].distance <= results[1].distance);
    assert.ok(results[1].distance <= results[2].distance);
    await models.sequelize.close();
    models = null;
    await run(process.execPath, [cli, 'db:migrate:undo:all', '--env', 'docker'], { env: process.env });
  } finally {
    if (models) await models.sequelize.close();
    await admin.query(`IF DB_ID('${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`);
    await admin.close();
  }
});
