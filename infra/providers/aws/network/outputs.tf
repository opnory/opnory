# Internal wiring only: the environment root routes these to the compute
# module. Not part of the lab host-contract; the root must not re-export them.
output "vpc_id" {
  description = "VPC id (internal wiring: compute places the instance in this VPC)"
  value       = aws_vpc.lab.id
}

output "subnet_id" {
  description = "Public subnet id (internal wiring: compute launches into this subnet)"
  value       = aws_subnet.lab.id
}

output "security_group_id" {
  description = "Lab security group id (internal wiring: compute attaches it to the instance)"
  value       = aws_security_group.lab.id
}
