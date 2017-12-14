'use strict';

var AWS = require('aws-sdk');
var chance = require('chance').Chance();
var utils = require('./modules/utils.js');
var hash = require('./modules/hash.js');
var Rx = require('rxjs/Rx');

/** AWS configuration */
AWS.config.update({ region: 'us-east-1' });
var db = new AWS.DynamoDB.DocumentClient();

var TABLE_NAME = 'GraphExample';
var ORGANIZATION_ID = hash('Conatel S.A.');
var GSI_PARTITIONS = 5;
var NODES = (module.exports = {
  createNode,
  getNodesOfType,
  deleteNode,
  addPropertyToNode
});

// ---
function randomNodeId(organizationId, type, data) {
  var seed = type + data;
  return organizationId + '#' + hash(seed);
}

function nodeItem(organizationId, type, data) {
  var node = randomNodeId(organizationId, type, data);
  return {
    Node: node,
    Type: type,
    Data: data,
    Target: node,
    GSIK: organizationId + '#' + chance.d4().toString()
  };
}

function edgeItem(organizationId, type, data, target) {
  var node = randomNodeId(organizationId, type, data);
  return {
    Node: node,
    Type: type,
    Data: data,
    Target: target,
    GSIK: organizationId + '#' + chance.d4().toString()
  };
}

function createNode(organizationId, type, data) {
  return db
    .put({
      TableName: TABLE_NAME,
      Item: nodeItem(organizationId, type, data)
    })
    .promise();
}

function deleteNode(organizationId, nodeId) {
  var node = organizationId + '#' + nodeId;
  return db
    .query({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#Node = :Node',
      ExpressionAttributeNames: {
        '#Node': 'Node'
      },
      ExpressionAttributeValues: {
        ':Node': node
      }
    })
    .promise()
    .then(response => {
      return Promise.all(
        response.Items.map(item =>
          db
            .delete({
              TableName: TABLE_NAME,
              Key: {
                Node: node,
                Type: item.Type
              }
            })
            .promise()
        )
      );
    });
}

function getNodesOfType(organizationId, type, depth) {
  depth || (depth = 0);
  var response = { Items: [], Count: 0, ScannedCount: 0 };
  return new Promise((resolve, reject) => {
    Rx.Observable.range(0, GSI_PARTITIONS)
      .mergeMap(i => {
        return Rx.Observable.fromPromise(
          db
            .query({
              TableName: TABLE_NAME,
              IndexName: 'ByType',
              KeyConditionExpression: `#GSIK = :GSIK AND #Type = :Type`,
              ExpressionAttributeNames: {
                '#GSIK': 'GSIK',
                '#Type': 'Type',
                '#Data': 'Data',
                '#Node': 'Node'
              },
              ExpressionAttributeValues: {
                ':GSIK': organizationId + '#' + i.toString(),
                ':Type': type
              },
              ProjectionExpression: '#Data,#Node'
            })
            .promise()
        );
      })
      .reduce(
        (acc, value) => ({
          Items: acc.Items.concat(value.Items),
          Count: acc.Count + value.Count,
          ScannedCount: acc.ScannedCount + value.ScannedCount
        }),
        Object.assign({}, response)
      )
      .mergeMap(result => {
        if (depth > 0) {
          return Rx.Observable.from(result.Items.map(item => item.Node))
            .mergeMap(node =>
              Rx.Observable.fromPromise(
                db
                  .query({
                    TableName: TABLE_NAME,
                    KeyConditionExpression: `#Node = :Node`,
                    ExpressionAttributeNames: {
                      '#Node': 'Node',
                      '#Target': 'Target'
                    },
                    ExpressionAttributeValues: {
                      ':Node': node
                    },
                    FilterExpression: '#Target <> :Node'
                  })
                  .promise()
              ).map(response => {
                var current = result.Items.find(item => {
                  return item.Node === node;
                });
                response.Items.forEach(item => {
                  current[item.Type] = item.Data;
                });
                return current;
              })
            )
            .reduce(acc => acc, result);
        }
        return Rx.Observable.of(result);
      })
      .subscribe({
        next: resolve,
        error: reject
      });
  });
}

function addPropertyToNode(organizationId, node, type, data) {
  return db
    .put({
      TableName: TABLE_NAME,
      Item: {
        Node: node,
        Type: type,
        Data: data
      }
    })
    .promise();
}