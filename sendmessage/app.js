const AWS = require('aws-sdk');

const ddb = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10', region: process.env.AWS_REGION });

const { TABLE_NAME } = process.env;

exports.handler = async event => {

  const recvMessage=JSON.parse(event.body);
  if(recvMessage.eventType=="custom/myVTT/keepalive")
    return { statusCode: 200, body: 'Data sent.' };

  const campaignId=recvMessage.campaignId;
  const senderId=event.requestContext.connectionId;

  try {
    connectionData = await ddb.query({
      TableName: TABLE_NAME,
      KeyConditionExpression: "campaignId = :hkey and begins_with(objectId,:skey)",
      ExpressionAttributeValues: {
        ':hkey': campaignId,
        ':skey': "conn#"
      },
    }).promise();
  } catch (e) {
    return { statusCode: 500, body: e.stack };
  }
  
  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });
  
  const postCalls = connectionData.Items.map(async ({ objectId }) => {
    const connectionId= objectId.substring(5); // CONN#ID  to ID
    if(connectionId==senderId){
      return;
    }
    try {
      await apigwManagementApi.postToConnection({ ConnectionId: connectionId, Data: event.body }).promise();
    } catch (e) {
      if (e.statusCode === 410) {
        console.log(`Found stale connection, deleting ${connectionId}`);
        await ddb.delete({ TableName: TABLE_NAME, Key: { campaignId: campaignId, objectId: objectId } }).promise();
      } else {
        throw e;
      }
    }
  });

  // STORE/UPDATE TOKEN DATA IN DYNAMODB.
  if(recvMessage.eventType=="custom/myVTT/token"){
    const objectId="scenes#"+recvMessage.sceneId+"#tokens#"+recvMessage.data.id;
    const putParams = {
      TableName: process.env.TABLE_NAME,
      Item: {
        campaignId: campaignId,
        objectId: objectId,
        data: recvMessage.data,
        timestamp: Date.now(),
      }
    };
    try {
      await ddb.put(putParams).promise();
    } catch (err) {
      return { statusCode: 500, body: 'Failed to connect: ' + JSON.stringify(err) };
    }
  }
  // TEMPORARY WAY OF STORING SCENE DATA INTO DYNAMODB FOR PREPARING THE FUTURE SWITCH. WE DISCARD TOKENS, DRAWINGS, AND REVELEAD FOG
  if(recvMessage.eventType=="custom/myVTT/scene"){
    const objectId="scenes#"+recvMessage.data.id+"#scenedata";
    delete recvMessage.data.tokens;
    delete recvMessage.data.reveals;
    delete recvMessage.data.drawings;
    const putParams = {
      TableName: process.env.TABLE_NAME,
      Item: {
        campaignId: campaignId,
        objectId: objectId,
        data: recvMessage.data,
        timestamp: Date.now(),
      }
    };
    try {
      await ddb.put(putParams).promise();
    } catch (err) {
      return { statusCode: 500, body: 'Failed to connect: ' + JSON.stringify(err) };
    }
  }


  try {
    await Promise.all(postCalls);
  } catch (e) {
    return { statusCode: 500, body: e.stack };
  }

  return { statusCode: 200, body: 'Data sent.' };
};
