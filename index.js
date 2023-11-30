const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const ip = require("ip");
const rds = require("@pulumi/aws/rds");
const route53 = require("@pulumi/aws/route53");
const iam = require("@pulumi/aws/iam");


const config = new pulumi.Config();
const region = aws.config.requireRegion();
const vpcCidrBlock = config.require("vpcCidrBlock");


const destinationCidrBlock = config.require("destinationCidrBlock");
const primaryVPCName = config.require("primaryVPCName");
const primaryIGWName = config.require("primaryIGWName");
const primaryPbRTAName = config.require("primaryPbRTAName");
const primaryPRTName = config.require("primaryPRTName");
const primaryPublicRoute = config.require("primaryPublicRoute");
const publicSubnetName = config.require("publicSubnetName");
const privateSubnetName  = config.require("privateSubnetName");
const publicRTAName = config.require("publicRTAName");
const privateRTAName = config.require("privateRTAName");

const ipv6CIDR = config.require("ipv6CIDR");
const portsConfig = config.get("ports");
const stringPorts = portsConfig.split(",");
const ports = stringPorts.map(port => parseInt(port, 10));
const dbPort = config.require("dbPort");
const appPort = config.require("appPort");
const loadBalancerConfig = config.require("loadBalancerConfig");
const dbFamily = config.require("dbFamily");
const dbEngine = config.require("dbEngine");
const rdsUsername = config.require("rdsUsername");
const rdsPassword = config.require("rdsPassword");
const rdsName = config.require("rdsDbName");

const cloudwatch_config = config.require("cloudwatch_config");
const domain_name = config.require("domain_name");
// const destinationCidrBlock = config.require("destinationCidrBlock");

const subnetCalculator = require('ip-subnet-calculator');


let [networkAddress, supernetAddress] = vpcCidrBlock.split("/");
let subnetInitialString = networkAddress.split(".")[0] + "." + networkAddress.split(".")[1] ;
const vpc = new aws.ec2.Vpc(primaryVPCName, {
    cidrBlock: vpcCidrBlock,
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: { Name: primaryVPCName },
});

// Create an Internet Gateway and attach it to the VPC
const ig = new aws.ec2.InternetGateway(primaryIGWName, {
  vpcId: vpc.id,
  tags: { Name: primaryIGWName }
});

// Create a public route table
const publicRouteTable = new aws.ec2.RouteTable(primaryPbRTAName, {
  vpcId: vpc.id,
  tags: { Name: primaryPbRTAName }
});

// Create a private route table
const privateRouteTable = new aws.ec2.RouteTable(primaryPRTName, {
  vpcId: vpc.id,
  tags: { Name: primaryPRTName }
});

// Create a public route
const publicRoute = new aws.ec2.Route(primaryPublicRoute, {
  routeTableId: publicRouteTable.id,
  destinationCidrBlock: destinationCidrBlock,
  gatewayId: ig.id,
  tags: { Name: primaryPublicRoute }
});

// Fetch the availability zones in the current region
const azs = pulumi.output(aws.getAvailabilityZones({
  state: "available",
}));

// let publicSubnets = [];
// let privateSubnets = [];

// Create a private and a public subnet in each availability zone (but limit to 3)
const subnets = azs.apply(azs => azs.names.slice(0, 3).map((name, index) => {
  // Private subnet
  const privateSubnet = new aws.ec2.Subnet(`${privateSubnetName}-${index}`, {
      vpcId: vpc.id,
      cidrBlock: `${subnetInitialString}.${index * 2}.0/24`,
      availabilityZone: name,
      tags: { Name: `${privateSubnetName}-${index}` }
  });
  // privateSubnets.push(privateSubnet);
 
  // Public subnet
  const publicSubnet = new aws.ec2.Subnet(`${publicSubnetName}-${index}`, {
      vpcId: vpc.id,
      cidrBlock: `${subnetInitialString}.${index * 2 + 1}.0/24`,
      availabilityZone: name,
      tags: { Name: `${publicSubnetName}-${index}` }
  });
  // publicSubnets.push(publicSubnet); 
 
  // Associate our route table with the public subnet
  const publicRouteTableAssociation = new aws.ec2.RouteTableAssociation(`${publicRTAName}-${index}`, {
      subnetId: publicSubnet.id,
      routeTableId: publicRouteTable.id,
      tags: { Name: `${publicRTAName}-${index}` }
  });

  // Associate our route table with the private subnet
  const privateRouteTableAssociation = new aws.ec2.RouteTableAssociation(`${privateRTAName}-${index}`, {
      subnetId: privateSubnet.id,
      routeTableId: privateRouteTable.id,
      tags: { Name: `${privateRTAName}-${index}` }
  });
 
  return { private: privateSubnet, public: publicSubnet };
}));

//Creating load balancer security group
const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup("load-balancer-security-group", {
  vpcId: vpc.id,
  description: "Security group for the load balancer",
});

// Add ingress rule to allow incoming traffic on ports 80 and 443
const lbIngressRuleHTTP = new aws.ec2.SecurityGroupRule("lb-ingress-rule-http", {
  type: "ingress",
  fromPort: 80,
  toPort: 80,
  protocol: "tcp",
  cidrBlocks: [destinationCidrBlock], 
  securityGroupId: loadBalancerSecurityGroup.id,
  description: "Allow HTTP traffic to the load balancer",
});
const lbEgressRuleHTTP = new aws.ec2.SecurityGroupRule("lb-egress-rule-http", {
  type: "egress",
  // fromPort: dbPort,
  // toPort: dbPort,
  // protocol: "tcp",
  cidrBlocks: [destinationCidrBlock],
  // ipv6CidrBlocks: [ipv6CIDR],
  securityGroupId: loadBalancerSecurityGroup.id,

  // Restricting access to internet
  protocol: "-1",
  fromPort: 0,
  toPort: 0,
  description: `Allow TCP egress on port `
});

const lbIngressRuleHTTPS = new aws.ec2.SecurityGroupRule("lb-ingress-rule-https", {
  type: "ingress",
  fromPort: 443,
  toPort: 443,
  protocol: "tcp",
  cidrBlocks: [destinationCidrBlock], // Allow from anywhere
  securityGroupId: loadBalancerSecurityGroup.id,
  description: "Allow HTTPS traffic to the load balancer",
});

//creating security group
const appSecurityGroup = new aws.ec2.SecurityGroup("application security group", {
  vpcId: vpc.id,
  description: "Security group for application",
});

const ruleIngressSSH = new aws.ec2.SecurityGroupRule(`ingress-rule-22`, {
  type: "ingress",
  fromPort: 22,
  toPort: 22,
  protocol: "tcp",
  cidrBlocks: [destinationCidrBlock],
  ipv6CidrBlocks: [ipv6CIDR],
  // sourceSecurityGroupId: loadBalancerSecurityGroup.id,
  securityGroupId: appSecurityGroup.id,
  description: `Allow TCP ingress on port 22`
});

const ruleIngressAPP = new aws.ec2.SecurityGroupRule(`ingress-rule-8080`, {
  type: "ingress",
  fromPort: 8080,
  toPort: 8080,
  protocol: "tcp",
  // cidrBlocks: [destinationCidrBlock],
  // ipv6CidrBlocks: [ipv6CIDR],
  sourceSecurityGroupId: loadBalancerSecurityGroup.id,
  securityGroupId: appSecurityGroup.id,
  description: `Allow TCP ingress on port 8080`
});

/*
for (const port of ports) {
  // Creating ingress rules
  const ruleIngress = new aws.ec2.SecurityGroupRule(`ingress-rule-${port}`, {
    type: "ingress",
    fromPort: port,
    toPort: port,
    protocol: "tcp",
    cidrBlocks: [destinationCidrBlock],
    // ipv6CidrBlocks: [ipv6CIDR],
    sourceSecurityGroupId: loadBalancerSecurityGroup.id,
    securityGroupId: appSecurityGroup.id,
    description: `Allow TCP ingress on port ${port}`
  });

  // Creating egress rules
  // const ruleEgress = new aws.ec2.SecurityGroupRule(`egress-rule-${port}`, {
  //   type: "egress",
  //   fromPort: port,
  //   toPort: port,
  //   protocol: "tcp",
  //   cidrBlocks: [destinationCidrBlock],
  //   ipv6CidrBlocks: [ipv6CIDR],
  //   securityGroupId: appSecurityGroup.id,
  //   description: `Allow TCP egress on port ${port}`
  // });
}
*/
// Creating DB security group
const dbSecurityGroup = new aws.ec2.SecurityGroup("dbSecurityGroup", {
  vpcId: vpc.id,
  
  description: "Security group for RDS instances",
});

const ruleIngressDb = new aws.ec2.SecurityGroupRule("ingress-rule-db", {
  type: "ingress",
  fromPort: dbPort, // MySQL port
  toPort: dbPort,
  protocol: "tcp",
  securityGroupId: dbSecurityGroup.id,
  sourceSecurityGroupId: appSecurityGroup.id, // Allow connection from application security group
  description: "Allow TCP ingress on port 3306 from application security group"
});

// Creating egress rules
const ruleEgress = new aws.ec2.SecurityGroupRule(`egress-rule-${3306}`, {
  type: "egress",
  // fromPort: dbPort,
  // toPort: dbPort,
  // protocol: "tcp",
  cidrBlocks: [destinationCidrBlock],
  // ipv6CidrBlocks: [ipv6CIDR],
  securityGroupId: appSecurityGroup.id,

  // Restricting access to internet
  protocol: "-1",
  fromPort: 0,
  toPort: 0,
  description: `Allow TCP egress on port ${dbPort}`
});


const publicSubnetIDs = subnets.apply(subnets => subnets.map(subnet => subnet.public.id));
const privateSubnetIDs = subnets.apply(subnets => subnets.map(subnet => subnet.private.id));
// A database subnet group
var dbSubnetGroup = new aws.rds.SubnetGroup("db-subnet-group", {
  subnetIds: privateSubnetIDs,
  tags: {
    Name: "db-subnet-group",
  },
});

// A database parameter group for MariaDB 10.6
var dbParameterGroup = new aws.rds.ParameterGroup("mariadb-parameter-group", {
  family: dbFamily, 
  vpcId: vpc.id,
  description: "Database parameter group for MariaDB 10.6",
  parameters: [
    {
      name: "character_set_server",
      value: "utf8",
    },
  ],
});

//-----------------
new aws.ec2.SecurityGroupRule("application-security-group-egress-rule", {
  type: "egress",
  protocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
  sourceSecurityGroupId: dbSecurityGroup.id,
  securityGroupId: appSecurityGroup.id,
  description: "Allow outbound TCP traffic on port 5432 from the application to the database instance",
});

new aws.ec2.SecurityGroupRule("application-security-group-port-egress-rule", {
  type: "egress",
  fromPort: 443,
  toPort: 443,
  protocol: "tcp",
  cidrBlocks: [destinationCidrBlock],
  ipv6CidrBlocks: [ipv6CIDR],
  securityGroupId: appSecurityGroup.id,
});

const policyDocument = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
      {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: {
              Service: "ec2.amazonaws.com",
          },
      },
  ],
});

const role = new iam.Role("cloudwatch-agent-role", {
  assumeRolePolicy: policyDocument,
  tags: {
      Name: "cloudwatch-agent-role",
  },
});

const instanceProfile = new iam.InstanceProfile("cloudwatch-instance-profile", {
  role: role.name,
  tags: {
      Name: "cloudwatch-instance-profile",
  },
});

new iam.RolePolicyAttachment("cloudwatch-agent-policy", {
  policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  role: role.name,
});


// Launch a MariaDB instance
var dbInstance = new aws.rds.Instance("csye6225", {
  vpcId: vpc.id,
  engine: dbEngine,
  instanceClass: "db.t3.micro",
  allocatedStorage: 20,
  storageType: "gp2",
  name: rdsName,
  username: rdsUsername,
  password: rdsPassword,
  vpcSecurityGroupIds: [ dbSecurityGroup.id ], // Referencing the security group
  dbSubnetGroupName: dbSubnetGroup.name, // Associating DB instance with DB subnet group
  parameterGroupName: dbParameterGroup.name, // Associating DB instance with DB parameter group
  skipFinalSnapshot: true,
  publiclyAccessible: false,
  multiAz: false,
});

// Create an Application Load Balancer
const loadBalancer = new aws.lb.LoadBalancer("web-app-load-balancer", {
  subnets: publicSubnetIDs, 
  enableDeletionProtection: false, 
  securityGroups: [loadBalancerSecurityGroup.id],
  publiclyAccessible: true,
  internal: false,
  loadBalancerType: "application",
});

// Attach the Auto Scaling Group to the Load Balancer
const targetGroup = new aws.lb.TargetGroup("web-app-target-group", {
  port: appPort, // Replace with your application's port
  protocol: "HTTP",
  targetType: "instance",
  vpcId: vpc.id,
  healthCheck: {
    enabled: true,
    interval: 30,
    path: "/healthz",
    port: appPort.toString(),
    protocol: "HTTP",
    timeout: 10,
},
});

const listener = new aws.lb.Listener("web-app-listener", {
  loadBalancerArn: loadBalancer.arn,
  port: 80,
  protocol: "HTTP",
  defaultActions: [
    {
      type: "forward",
      targetGroupArn: targetGroup.arn
        
    },
  ],
});

// Create SNS Topic
const snsTopic = new aws.sns.Topic("webapp-assignment-submission", {
  tags: { Name: "webapp-assignment-submission" },
  
});
/*
const snsPublishPolicy = new aws.iam.Policy("sns-publish-policy", {
  description: "Allows publishing to SNS topic",
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "sns:Publish",
        Resource: snsTopic.arn,
      },
    ],
  }),
});

const snsPublishPolicyAttachment = new aws.iam.PolicyAttachment("sns-publish-policy-attachment", {
  policyArn: snsPublishPolicy.arn,
  roles: [role.name], 
});
*/
new aws.iam.RolePolicyAttachment("sns-publish-policy-attachment", {
  role: role.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonSNSFullAccess",  
});



const gcp = require("@pulumi/gcp");
const gcpProject = config.get("project");
// Create a DynamoDB table
// Define DynamoDB table's attribute and key schema
/*
let emailTableAttributes = [
  { name: "receiver", type: "S" },
  { name: "sender", type: "S" },
  { name: "sentAt", type: "S" },
  { name: "subject", type: "S" },
];

let emailTableKeys = [
  { attributeName: "receiver", keyType: "HASH" },
  { attributeName: "sender", keyType: "RANGE" },
];

// Create a DynamoDB table
const emailTable = new aws.dynamodb.Table("emailTable", {
  attributes: emailTableAttributes,
  hashKey: "receiver",
  rangeKey: "sender",
  readCapacity: 5,
  writeCapacity: 5,
  globalSecondaryIndexes: [{
      name: "SentAtAndSubject",
      hashKey: "sentAt",
      rangeKey: "subject",
      readCapacity: 5,
      writeCapacity: 5,
      projectionType: "ALL",
  }]
});
*/

const emailTableAttributes = [
  { name: "id", type: "S" },
  { name: "emailSentTime", type: "S" },
  { name: "status", type: "S" },
  { name: "submissionURL", type: "S" },
  { name: "gcsURL", type: "S" },
  { name: "authenticatedURL", type: "S" },
  { name: "assignmentId", type: "S" }
];

// Create a DynamoDB table
const emailTable = new aws.dynamodb.Table("emailTable", {
  attributes: emailTableAttributes,
  hashKey: "id", // Use 'id' as the primary key
  readCapacity: 5,
  writeCapacity: 5,
  globalSecondaryIndexes: [
    {
      name: "EmailSentTimeIndex",
      hashKey: "emailSentTime", // Create a GSI based on emailSentTime
      projectionType: "ALL",
      readCapacity: 5,
      writeCapacity: 5,
    },
    {
      name: "gcsURLIndex",
      hashKey: "gcsURL", // Create a GSI based on emailSentTime
      projectionType: "ALL",
      readCapacity: 5,
      writeCapacity: 5,
    },
    {
      name: "AssignmentIdIndex",
      hashKey: "assignmentId", // Create a GSI based on emailSentTime
      projectionType: "ALL",
      readCapacity: 5,
      writeCapacity: 5,
    },
    {
      name: "StatusIndex",
      hashKey: "status", // Create a GSI based on emailSentTime
      projectionType: "ALL",
      readCapacity: 5,
      writeCapacity: 5,
    },
    {
      name: "AuthenticatedUrlIndex",
      hashKey: "authenticatedURL", // Create a GSI based on emailSentTime
      projectionType: "ALL",
      readCapacity: 5,
      writeCapacity: 5,
    },
    {
      name: "SubmissionURLIndex",
      hashKey: "submissionURL", // Create a GSI based on emailSentTime
      projectionType: "ALL",
      readCapacity: 5,
      writeCapacity: 5,
    }
  ],
});




// Create an IAM role and attach a policy that allows the Lambda function to access 
// DynamoDB, SNS, CloudWatch, and the google cloud bucket
const lambdaRole = new aws.iam.Role("lambdaRole", {
  assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: {
              Service: "lambda.amazonaws.com",
          },
      }],
  }),
});

const lambdaRolePolicyAttachment = new aws.iam.RolePolicyAttachment(
  "lambdaRolePolicyAttachment",
  {
    role: lambdaRole.name,
    policyArn:
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  }
);



/*
new aws.iam.RolePolicy("lambdaRolePolicyExtra", {
  role: lambdaRole.id,
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: [
          "dynamodb:*",
          "sns:*",
          "s3:*",
          // Add CloudWatch log permissions
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        Effect: "Allow",
        Resource: "*",
      },
    ],
  }),
});
*/
const lambdaCodeArchivePath = config.require("lambdaCodeArchivePath");
const gcpBucketName = config.require("gcpBucketName");


// const lambdaLogGroupName = pulumi.interpolate`/aws/lambda/${lambdaFunction.name}`;
// const lambdaLogGroup = new aws.cloudwatch.LogGroup("lambdaLogGroup", {
//   name: lambdaLogGroupName,
// });



// Create a new GCP service account
const serviceAccount = new gcp.serviceaccount.Account("webappServiceAccount", {
  accountId: "webapp-service-account", 
  project: gcpProject, // Replace with your GCP project ID
});

// Create an access key for the service account
const accessKey = new gcp.serviceaccount.Key("webappAccessKey", {
  serviceAccountId: serviceAccount.accountId,
});

// Create a Google Cloud Storage bucket
const bucket = new gcp.storage.Bucket(gcpBucketName, {
  name: gcpBucketName, 
  location: "US", 
  project: gcpProject, 
});

// Define bucket permissions
const bucketIAMBinding = new gcp.storage.BucketIAMBinding("storage-object-binding", {
  bucket: bucket.name,
  role: "roles/storage.admin",
  members: [serviceAccount.email.apply(email => `serviceAccount:${email}`)],
}, {
  dependsOn: [bucket],
});

const base64EncodedKey = accessKey.privateKey.apply((key) =>
  Buffer.from(key).toString("ascii")
);

const mySecret = new aws.secretsmanager.Secret("ServiceAccountKey", {
  name: "service-account-key",
});

const secretsManagerPolicy = mySecret.arn.apply((arn) => {
  return new aws.iam.Policy("secretsManagerPolicy", {
    description: "IAM policy for Lambda to access secrets in Secrets Manager",
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "secretsmanager:GetSecretValue",
          Effect: "Allow",
          Resource: arn, // Use the resolved ARN of your secret
        },
      ],
    }),
  });
});

const policyAttachmentSecretsManager = secretsManagerPolicy.apply((policy) => {
  return new aws.iam.RolePolicyAttachment(
    "myLambdaRoleSecretsManagerAttachment",
    {
      role: lambdaRole,
      policyArn: policy.arn,
    }
  );
});

const mySecretVersion = new aws.secretsmanager.SecretVersion(
  "myServiceAccountKeyVersion",
  {
    secretId: mySecret.id,
    secretString: base64EncodedKey,
  }
);

const lambdaFunction = new aws.lambda.Function("lambdaFunction", {
  // runtime: aws.lambda.NODEJS18dXRuntime, 
  code: new pulumi.asset.AssetArchive({
    ".": new pulumi.asset.FileArchive("serverless.zip"),
  }), 
  handler: "serverless/index.handler", 
  runtime: "nodejs18.x", 
  role: lambdaRole.arn,
  environment: {
    variables: {
      MAILGUN_API_KEY: "5afed9ffd0cc21c75948c57c5d897701-30b58138-e5f59ab8",
      MAILGUN_DOMAIN: "cloudneu.me",
      GOOGLE_CLOUD_BUCKET_NAME: gcpBucketName,
      DYNAMODB_TABLE_NAME: emailTable.name,
      SERVICE_ACCOUNT_KEY: accessKey.privateKey,
      SECRET_ARN: mySecret.arn,
      GOOGLE_PROJECT_ID: gcpProject,
      REGION: region,
    },
  },
});

const snsSubscription = new aws.sns.TopicSubscription("lambdaSubscription", {
  topic: snsTopic,
  protocol: "lambda",
  endpoint: lambdaFunction.arn,
});

// Ensure that your Lambda function's role has permissions to invoke Lambda
const lambdaPermission = new aws.lambda.Permission("lambdaPermission", {
  action: "lambda:InvokeFunction",
  function: lambdaFunction.name,
  principal: "sns.amazonaws.com",
  sourceArn: snsTopic.arn,
});


// Create Google Cloud Storage bucket
// const bucket = new gcp.storage.Bucket(gcpBucketName, {
//   location: "US",
// });

// Creating EC2 instance
const keyName = config.require("key-name");
const instanceType = config.require("instance-type");
const amiID = config.require("ami-ID");
const publicSubnetID = subnets.apply(subnets => subnets.map(subnet => subnet.public.id))[0];
const rdsEndpoint = dbInstance.address;
const logFilePath = config.require("logFilePath");

let dbConfig = pulumi
  .all({
    username: rdsUsername,
    password: rdsPassword,
    address: rdsEndpoint, // You might need to adjust depending upon object structure
    dialect: "mysql",
    name: rdsName,
    users_csv_path: "/opt/csye6225/users.csv",
    statsd_host: "localhost",
    statsd_port: "8125",
    cloudwatch_config: cloudwatch_config,
    sns_topic: snsTopic.arn,
    aws_region: region,
    logs_file_path: logFilePath,
  })
  .apply((db) =>
    [
      "#!/bin/bash",
      "cd /opt/csye6225",
      "sudo touch .env",
      'echo "Setting up environment variables..."',
      `echo 'DB_USER=${db.username}' >> .env`,
      `echo 'DB_PASSWORD=${db.password}' >> .env`,
      `echo 'DB_HOST=${db.address}' >> .env`,
      `echo 'DB_DIALECT=${db.dialect}' >> .env`,
      `echo 'DB_NAME=${db.name}' >> .env`,
      `echo 'USERS_CSV_PATH=${db.users_csv_path}' >> .env`,
      `echo 'STATSD_HOST=${db.statsd_host}' >> .env`,
      `echo 'STATSD_PORT=${db.statsd_port}' >> .env`,
      `echo 'SNS_TOPIC_ARN=${db.sns_topic}' >> .env`,
      `echo 'AWS_REGION=${db.aws_region}' >> .env`,
      `echo 'LOGS_FILE_PATH=${db.logs_file_path}' >> .env`,
      ``,
      "sudo chown csye6225:csye6225 /opt/csye6225/*",
      "sudo chown csye6225:csye6225 /opt/users.csv",
      "sudo chmod 660 /opt/csye6225/.env",
      "sudo touch /var/log/webapp.log",
      "sudo chown csye6225:csye6225 /var/log/webapp.log",
      `sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
        -a fetch-config \
        -m ec2 \
        -c file:${cloudwatch_config} \
        -s\
        `,
      "sudo systemctl enable amazon-cloudwatch-agent",
      "sudo systemctl start amazon-cloudwatch-agent"
    ].join("\n")
  );



// Create an EC2 launch template
const ec2LaunchTemplate = new aws.ec2.LaunchTemplate("ec2LaunchTemplate", {
  imageId: amiID, // Replace with your AMI ID
  launchTemplateName: "webapp-launch-template", 
  // version: "$Latest", // Use the latest version
  // blockDeviceMappings: [
  //     {
  //         deviceName: "/dev/xvda",
  //         ebs: {
  //             volumeSize: 30, // Adjust the volume size as needed
  //         },
  //     },
  // ],
  disableApiTermination: false,
  instanceType: instanceType,
  keyName: keyName,
  networkInterfaces: [
    {
      associatePublicIpAddress: true,
      securityGroups: [appSecurityGroup.id],
    },
  ],
  userData: dbConfig.apply(data => Buffer.from(data).toString('base64')), 
  iamInstanceProfile: {name: instanceProfile.name},
  ebsBlockDevices: [
    {
      deviceName: "/dev/xvda",
      volumeSize: 25,
      volumeType: "gp2",
      deleteOnTermination: true,
    },
  ],
  dependsOn: [dbInstance],
  tags: {
      Name: "Cloud-WebApp-Instance",
  
  }
});


const autoScalingGroup = new aws.autoscaling.Group("AutoScalerGroup", {
  vpcZoneIdentifiers: publicSubnetIDs, // Replace with your public subnet IDs
  desiredCapacity: 1,
  maxSize: 3,
  minSize: 1,
  // defaultCooldown: 60,
  // healthCheckType: "ELB",
  // healthCheckGracePeriod: 10,
  launchTemplate: {
      id: ec2LaunchTemplate.id, // Replace with your launch template ID
  },
  targetGroupArns: [targetGroup.arn], // Replace with your target group ARN
  publiclyAccessible: true,
});


// Create the scale up policy
const scaleUpPolicy = new aws.autoscaling.Policy("scaleUp", {
  scalingAdjustment: 1,
  adjustmentType: "ChangeInCapacity",
  cooldown: 60,
  autoscalingGroupName: autoScalingGroup.name,
  policyType: "SimpleScaling",
});

// Create alarm that triggers the scaleup policy
const scaleUpCpuAlarm = new aws.cloudwatch.MetricAlarm("scaleUpCpuAlarm", {
  comparisonOperator: "GreaterThanOrEqualToThreshold",
  evaluationPeriods: "2",
  metricName: "CPUUtilization",
  namespace: "AWS/EC2",
  period: "60",
  statistic: "Average",
  threshold: "5",
  alarmDescription: "This metric checks cpu usage and triggers a scale up policy",
  alarmActions: [scaleUpPolicy.arn],
  dimensions: {
      AutoScalingGroupName: autoScalingGroup.name,
  },
});



// Create the scale down policy
const scaleDownPolicy = new aws.autoscaling.Policy("scaleDown", {
  scalingAdjustment: -1,
  adjustmentType: "ChangeInCapacity",
  cooldown: 60,
  autoscalingGroupName: autoScalingGroup.name,
  policyType: "SimpleScaling",
});
// Create alarm that triggers the scaledown policy
const scaleDownCpuAlarm = new aws.cloudwatch.MetricAlarm("scaleDownCpuAlarm", {
  comparisonOperator: "LessThanOrEqualToThreshold",
  evaluationPeriods: "2",
  metricName: "CPUUtilization",
  namespace: "AWS/EC2",
  period: "60",
  statistic: "Average",
  threshold: "3",
  alarmDescription: "This metric checks cpu usage and triggers a scale down policy",
  alarmActions: [scaleDownPolicy.arn],
  dimensions: {
      AutoScalingGroupName: autoScalingGroup.name,
  },
});

const zone = aws.route53.getZone({ name: domain_name }, { async: true });

// // Get the hosted zone by ID.
const zoneID = aws.route53
  .getZone({ name: domain_name })
  .then((zone) => zone.zoneId);

  const record = new aws.route53.Record("A-record-domain", {
    name: domain_name,
    type: "A",
    zoneId: zoneID,
    aliases: [
      {
        name: loadBalancer.dnsName,
        zoneId: loadBalancer.zoneId,
        evaluateTargetHealth: true,
      },
    ],
  });

// Export the IDs of the created resources
exports.vpcId = vpc.id;
exports.privateSubnetIds = subnets.apply(subnets => subnets.map(subnet => subnet.private.id));
exports.publicSubnetIds = subnets.apply(subnets => subnets.map(subnet => subnet.public.id));
exports.publicRouteTableId = publicRouteTable.id;
exports.privateRouteTableId = privateRouteTable.id;
exports.internetGatewayId = ig.id;
exports.publicRouteId = publicRoute.id;
exports.dbHostname = dbInstance.endpoint;
