import AWS from 'aws-sdk';

const rds = new AWS.RDS();
const sts = new AWS.STS();

async function test() {
    try {
        console.log('Checking AWS identity via default credential chain...');
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
