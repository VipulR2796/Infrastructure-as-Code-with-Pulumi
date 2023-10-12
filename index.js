const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const ip = require("ip");


const config = new pulumi.Config();
const region = aws.config.requireRegion();
const vpcCidrBlock = config.require("vpcCidrBlock");
const subnetCalculator = require('ip-subnet-calculator');

const vpc = new aws.ec2.Vpc("dev-vpc-1", {
    cidrBlock: vpcCidrBlock,
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: { Name: "dev-vpc-1" },
});

// const availabilityZones = aws.getAvailabilityZones({state: "available"});
// console.log('------', availabilityZones);
// const numberOfAZ = availabilityZones.then(azs => azs.names.length);
// console.log('+++++', numberOfAZ);

const availabilityZones = [region+"a", region+"b", region+"c"];
const numberOfAZ = availabilityZones.length;

// const availabilityZones = aws.getAvailabilityZones({ state: "available" });
// const numberOfAZ = availabilityZones.then(azs => azs.names.length);
console.log('+++++', numberOfAZ);

const publicSubnets = [];
const privateSubnets = [];

//Create 3 public and 3 private subnets in specified availability zones.
for (let i = 0; i < numberOfAZ; i++) {
  const publicSubnet = new aws.ec2.Subnet(`public-subnet-${i}`, {
    vpcId: vpc.id,
    availabilityZone: availabilityZones[i],//availabilityZones.then(azs => azs.names[i]),


// Create 3 public and 3 private subnets in specified availability zones.
for (let i = 0; i < numberOfAZ; i++) {
  const publicSubnet = new aws.ec2.Subnet(`public-subnet-${i}`, {
    vpcId: vpc.id,
    availabilityZone: availabilityZones[i],
    cidrBlock: `10.0.${i + 1}.0/24`,
    mapPublicIpOnLaunch: true,
    tags: {
      Name: `public-subnet-${i}`,
    },
  });
  publicSubnets.push(publicSubnet);

  const privateSubnet = new aws.ec2.Subnet(`private-subnet-${i}`, {
    vpcId: vpc.id,
    availabilityZone: availabilityZones[i], //vailabilityZones.then(azs => azs.names[i]),
    cidrBlock: `10.0.${i + numberOfAZ+1}.0/24`,

    tags: {
      Name: `private-subnet-${i}`,
    },
  });
  privateSubnets.push(privateSubnet);
}


// Create an Internet Gateway resource

const internetGateway = new aws.ec2.InternetGateway("dev-internetGateway", {
    vpcId: vpc.id,
    tags: { Name: "dev-internetGateway" },
});

// Create a public route table
const publicRouteTable = new aws.ec2.RouteTable("dev-publicRouteTable", {
    vpcId: vpc.id,
    tags: { Name: "dev-publicRouteTable" },
});

// Attach all public subnets to the public route table

for (let i = 0; i < numberOfAZ; i++) {
    const publicSubnetAssociation = new aws.ec2.RouteTableAssociation(`public-subnet-assoc-${i}`, {
        subnetId: publicSubnets[i].id,
        routeTableId: publicRouteTable.id,
    });
}

// Create a private route table
const privateRouteTable = new aws.ec2.RouteTable("dev-privateRouteTable", {
    vpcId: vpc.id,
    tags: { Name: "dev-privateRouteTable" },
});

// Attach all private subnets to the private route table
for (let i = 0; i < numberOfAZ; i++) {
    const privateSubnetAssociation = new aws.ec2.RouteTableAssociation(`private-subnet-assoc-${i}`, {
        subnetId: privateSubnets[i].id,
        routeTableId: privateRouteTable.id,
    });
}

// Create a public route in the public route table with the destination CIDR block 0.0.0.0/0 and the internet gateway as the target
const publicRoute = new aws.ec2.Route("dev-publicRoute", {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: "0.0.0.0/0",
    gatewayId: internetGateway.id,
});


exports.vpcId = vpc.id;
exports.publicSubnetIds = publicSubnets.map(subnet => subnet.id);

// exports.publicSubnetIds = subnetResults.then(results => results.map(result => result[0].id));
// exports.privateSubnetIds = subnetResults.then(results => results.map(result => result[1].id));

exports.privateSubnetIds = privateSubnets.map(subnet => subnet.id);
exports.internetGatewayId = internetGateway.id;
exports.publicRouteTableId = publicRouteTable.id;
exports.privateRouteTableId = privateRouteTable.id;

