const AWS = require('aws-sdk');

exports.handler = async event => {
  return { statusCode: 200, body: 'Connected.' };
};
