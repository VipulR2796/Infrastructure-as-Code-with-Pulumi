const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const ip = require("ip");


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

//creating security group
const securityGroup = new aws.ec2.SecurityGroup("application security group", {
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
    cidrBlocks: [destinationCidrBlock],
    ipv6CidrBlocks: [ipv6CIDR],
    securityGroupId: securityGroup.id,
    description: `Allow TCP ingress on port ${port}`
  });

  // Creating egress rules
  const ruleEgress = new aws.ec2.SecurityGroupRule(`egress-rule-${port}`, {
    type: "egress",
    fromPort: port,
    toPort: port,
    protocol: "tcp",
    cidrBlocks: [destinationCidrBlock],
    ipv6CidrBlocks: [ipv6CIDR],
    securityGroupId: securityGroup.id,
    description: `Allow TCP egress on port ${port}`
  });
}

const keyName = config.require("key-name");
const instanceType = config.require("instance-type");
const amiID = config.require("ami-ID");
const publicSubnetID = subnets.apply(subnets => subnets.map(subnet => subnet.public.id))[0];

const webInstance = new aws.ec2.Instance("web", {
  ami: amiID,
  subnetId: publicSubnetID,
  keyName: keyName,
  disableApiTermination: false,
  instanceType: instanceType,
  vpcSecurityGroupIds: [securityGroup.id],
  associatePublicIpAddress: true,
  tags: {
      Name: "Cloud-WebApp-Instance"
  }
});

// Export the IDs of the created resources
exports.vpcId = vpc.id;
exports.privateSubnetIds = subnets.apply(subnets => subnets.map(subnet => subnet.private.id));
exports.publicSubnetIds = subnets.apply(subnets => subnets.map(subnet => subnet.public.id));
exports.publicRouteTableId = publicRouteTable.id;
exports.privateRouteTableId = privateRouteTable.id;
exports.internetGatewayId = ig.id;
exports.publicRouteId = publicRoute.id;
exports.instanceId = webInstance.id;



