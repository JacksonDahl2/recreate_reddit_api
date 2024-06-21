terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      version = "5.11.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_sqs_queue" "data_queue" {
  name                       = "reddit-scraper-queue"
  visibility_timeout_seconds = 30

  tags = {
    Project   = "reddit-scraper"
    CreatedBy = "Terraform "
  }
}