## Infrastructure as Code with Pulumi

Command to import SSL Certificate:

      aws acm import-certificate --profile demo \
          --certificate fileb://demo_cloudneu_me.crt \
          --private-key fileb://private.key
