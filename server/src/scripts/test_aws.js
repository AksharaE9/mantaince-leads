import AWS from 'aws-sdk';
import dotenv from 'dotenv';
dotenv.config();

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION || 'eu-north-1'
});

const rds = new AWS.RDS();
const sts = new AWS.STS();

async function test() {
    try {
        console.log('Checking AWS identity...');
        const identity = await sts.getCallerIdentity().promise();
        console.log('✅ Identity:', identity);

        console.log('Listing RDS DB instances...');
        const rdsRes = await rds.describeDBInstances({ DBInstanceIdentifier: 'leadsbase-db' }).promise();
        console.log('✅ RDS instance found:', rdsRes.DBInstances[0]?.DBInstanceStatus);
    } catch (err) {
        console.error('❌ AWS Error:', err.message);
    }
}

test();
