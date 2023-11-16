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
  cidrBlocks: [destinationCidrBlock], // Allow from anywhere
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

for (const port of ports) {
  // Creating ingress rules
  const ruleIngress = new aws.ec2.SecurityGroupRule(`ingress-rule-${port}`, {
    type: "ingress",
    fromPort: port,
    toPort: port,
    protocol: "tcp",
    // cidrBlocks: [destinationCidrBlock],
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
    interval: 60,
    path: "/healthz",
    port: appPort.toString(),
    protocol: "HTTP",
    timeout: 5,
},
});

const listener = new aws.lb.Listener("web-app-listener", {
  loadBalancerArn: loadBalancer.arn,
  port: 80,
  protocol: "HTTP",
  defaultActions: [
    {
      type: "fixed-response",
      fixedResponse: {
        contentType: "text/plain",
        statusCode: "200",
        
      },
    },
  ],
});

// Attach the target group to the listener
const targetGroupAttachment = new aws.lb.ListenerRule("web-app-listener-rule", {
  listenerArn: listener.arn,
  actions: [{
    type: "forward",
    targetGroupArn: targetGroup.arn,
  }],
  conditions: [{
    pathPattern: {
      values: ["/"], // Route traffic to the root context
    },
  }],
});

// Creating EC2 instance
const keyName = config.require("key-name");
const instanceType = config.require("instance-type");
const amiID = config.require("ami-ID");
const publicSubnetID = subnets.apply(subnets => subnets.map(subnet => subnet.public.id))[0];
const rdsEndpoint = dbInstance.address;

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


  // Create a launch configuration for the Auto Scaling Group
// const launchConfig = new aws.ec2.LaunchConfiguration("asg-launch-config", {
//   imageId: amiID,
//   subnetId: publicSubnetID,
//   keyName: keyName,
//   disableApiTermination: false,
//   instanceType: instanceType,
//   vpcSecurityGroupIds: [appSecurityGroup.id],
//   associatePublicIpAddress: true,
//   userData: dbConfig,
//   iamInstanceProfile: instanceProfile.name,
//   dependsOn: [dbInstance],
//   tags: {
//       Name: "Cloud-WebApp-Instance",
  
//   }
// });

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
  vpcSecurityGroupIds: [appSecurityGroup.id],
  associatePublicIpAddress: true,
  userData: dbConfig.apply(data => Buffer.from(data).toString('base64')), 
  iamInstanceProfile: {name: instanceProfile.name},
  dependsOn: [dbInstance],
  tags: {
      Name: "Cloud-WebApp-Instance",
  
  }
});

// Create an Auto Scaling Group
// const autoScalingGroup = new aws.autoscaling.Group("web-app-auto-scaling-group", {
//   availabilityZones: azs.names.slice(0, 3), // Use the first 3 availability zones
//   launchConfiguration: launchConfig.name,
//   minSize: 1,
//   maxSize: 3,
//   desiredCapacity: 1,
//   cooldown: 60, // Adjust as needed
//   // Add tags and other configuration options as needed
// });

const autoScalingGroup = new aws.autoscaling.Group("AutoScalerGroup", {
  vpcZoneIdentifiers: publicSubnetIDs, // Replace with your public subnet IDs
  desiredCapacity: 1,
  maxSize: 3,
  minSize: 1,
  defaultCooldown: 60,
  healthCheckType: "ELB",
  healthCheckGracePeriod: 10,
  launchTemplate: {
      id: ec2LaunchTemplate.id, // Replace with your launch template ID
  },
  targetGroupArns: [targetGroup.arn], // Replace with your target group ARN
  publiclyAccessible: true,
});

// const scaleUpPolicy = new aws.autoscaling.Policy("scaleUpPolicy", {
//   adjustmentType: "ChangeInCapacity",
//   autoscalingGroupName: autoScalingGroup.name,
//   scalingAdjustment: 1, // Increment by 1
//   cooldown: 60, // Cooldown period in seconds
//   policyType: "SimpleScaling",
//   // estimatedInstanceWarmup: 300, // Optional warm-up time
//   targetTrackingConfiguration: {
//     predefinedMetricSpecification: {
//       predefinedMetricType: "ASGAverageCPUUtilization", // Use CPU utilization metric
//     },
//     targetValue: 5, // Target CPU utilization percentage to trigger scaling
//   },
// });

// const scaleDownPolicy = new aws.autoscaling.Policy("scaleDownPolicy", {
//   adjustmentType: "ChangeInCapacity",
//   autoscalingGroupName: autoScalingGroup.name,
  
//   scalingAdjustment: -1, // Decrement by 1
//   cooldown: 60, // Cooldown period in seconds
//   policyType: "SimpleScaling",
//   // estimatedInstanceWarmup: 300, // Optional warm-up time
//   targetTrackingConfiguration: {
//     predefinedMetricSpecification: {
//       predefinedMetricType: "ASGAverageCPUUtilization", // Use CPU utilization metric
//     },
//     targetValue: 3, // Target CPU utilization percentage to trigger scaling
//   },
// });

// const scaleUpPolicyAttachment = new aws.iam.PolicyAttachment("scaleUpPolicyAttachment", {
//   policyArn: scaleUpPolicy.arn,
//   groups: [autoScalingGroup.name], // Attach to the Auto Scaling Group
// });

// const scaleDownPolicyAttachment = new aws.iam.PolicyAttachment("scaleDownPolicyAttachment", {
//   policyArn: scaleDownPolicy.arn,
//   groups: [autoScalingGroup.name], // Attach to the Auto Scaling Group
// });





// const webInstance = new aws.ec2.Instance("web", {
//   ami: amiID,
//   subnetId: publicSubnetID,
//   keyName: keyName,
//   disableApiTermination: false,
//   instanceType: instanceType,
//   vpcSecurityGroupIds: [appSecurityGroup.id],
//   associatePublicIpAddress: true,
//   userData: dbConfig,
//   iamInstanceProfile: instanceProfile.name,
//   //publiclyAccessible: false,
//   tags: {
//       Name: "Cloud-WebApp-Instance",
//   },
//   dependsOn: [dbInstance],
// });



// Create the scale up policy
const scaleUpPolicy = new aws.autoscaling.Policy("scaleUp", {
  scalingAdjustment: 1,
  adjustmentType: "ChangeInCapacity",
  cooldown: 300,
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
  cooldown: 300,
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

// const zone = aws.route53.getZone({ name: domain_name }, { async: true });

// // Get the hosted zone by ID.
// const zoneID = aws.route53
//   .getZone({ name: domain_name })
//   .then((zone) => zone.zoneId);

// const zoneID = new route53.getZone({
//   name: domain_name,
// });
// const record = new aws.route53.Record(`A-record-domain`, {
//   name: domain_name,
//   type: "A",
//   ttl: 60,
//   records: [webInstance.publicIp],
//   zoneId: zoneID,
// });

// const recordName = domain_name + ".tld"; // Replace with your domain

// const route53Record = new aws.route53.Record("web-app-dns-record", {
//   name: recordName,
//   type: "A",
//   ttl: 60,
//   zoneId: zoneID,
//   aliases: [
//     {
//       evaluateTargetHealth: true,
//       name: loadBalancer.dnsName,
//       zoneId: loadBalancer.zoneId,
//     },
//   ],
// });

// Fetch the hosted Zone using the domain name
const hostedZoneId = aws.route53.getZone({ name: domain_name}, { async: true });

// Create A Record which points to the Load Balancer
const aRecord = new aws.route53.Record("aRecord", {
    name: domain_name,  // Replace with your subdomain name
    type: "A",
    zoneId: hostedZoneId.then(hostedZoneId => hostedZoneId.zoneId),
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
// exports.instanceId = asg.id;
// Export the hostname of the RDS instance
exports.dbHostname = dbInstance.endpoint;



