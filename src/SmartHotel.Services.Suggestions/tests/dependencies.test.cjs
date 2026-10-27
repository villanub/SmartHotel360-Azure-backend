const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const express = require('express');
const { Sequelize } = require('sequelize');
const models = require('../data/models');
const queries = require('../queries/suggestionsQuery');
const config = require('../data/config/config.json');

after(() => models.sequelize.close());

test('model factory loads the existing MSSQL table and attributes', () => {
  assert.equal(models.Suggestion.getTableName(), 'Suggestions');
  assert.equal(models.sequelize.getDialect(), 'mssql');
  for (const name of ['name', 'latitude', 'longitude', 'description', 'rating']) {
    assert.ok(models.Suggestion.rawAttributes[name], name);
  }
});

test('MSSQL query generation escapes text and rejects invalid identifier objects', () => {
  const generator = models.sequelize.getQueryInterface().queryGenerator;
  const sql = generator.selectQuery('Suggestions', {
    attributes: ['name'], where: { name: "O'Brien'; DROP TABLE Suggestions;--" }
  }, models.Suggestion);
  assert.match(sql, /O''Brien''; DROP TABLE Suggestions;--/);
  assert.throws(() => generator.quoteIdentifier({ toString: () => 'name' }));
});

test('nearest-location query preserves ordering, raw rows and limit', async (t) => {
  t.mock.method(models.Suggestion, 'findAll', async (options) => {
    assert.deepEqual(options, { raw: true });
    return [{ id: 2, latitude: 48, longitude: -122 },
      { id: 1, latitude: 47.6, longitude: -122.3 }];
  });
  const result = await queries.get({ latitude: '47.6', longitude: '-122.3' }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
  assert.equal(result[0].distance, 0);
});

test('suggestions route preserves required coordinates and successful JSON response', async (t) => {
  let databaseUnavailable = false;
  t.mock.method(models.Suggestion, 'findAll', async () => {
    if (databaseUnavailable) throw new Error('database unavailable');
    return [{ id: 1, latitude: 47.6, longitude: -122.3 }];
  });
  const app = express();
  app.use('/suggestions', require('../routes/suggestions'));
  app.use((error, request, response, next) => response.status(500).send('Request failed'));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/suggestions`;
  assert.equal((await fetch(url)).status, 400);
  assert.equal((await fetch(`${url}?latitude=47.6`)).status, 400);
  const response = await fetch(`${url}?latitude=47.6&longitude=-122.3`);
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].id, 1);
  assert.equal((await fetch(`${url}?latitude=bad&longitude=-122.3`)).status, 500);
  databaseUnavailable = true;
  assert.equal((await fetch(`${url}?latitude=47.6&longitude=-122.3`)).status, 500);
  databaseUnavailable = false;
  assert.equal((await fetch(`${url}?latitude=47.6&longitude=-122.3`)).status, 200);
});

test('URL configurations preserve Docker and production encryption settings', async () => {
  for (const [environment, encrypt] of [['local', false], ['docker', false], ['production', true]]) {
    const connection = new Sequelize('mssql://test:test@127.0.0.1:1433/test', config[environment]);
    try {
      assert.equal(connection.config.dialectOptions.options.encrypt, encrypt);
      assert.equal(connection.config.dialectOptions.options.trustServerCertificate === true, environment !== 'production');
      assert.equal(connection.getDialect(), 'mssql');
    } finally {
      await connection.close();
    }
  }
});
