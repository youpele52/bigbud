//! Throwaway public host keys for tests (generated with `ssh-keygen`;
//! fingerprints from `ssh-keygen -l`). No private material.

pub(crate) const ECDSAB256: (&str, &str) = (
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLdjdkVoYkrMcfjD42K91lN/HvKubVLd8Sz0AoWabeRjXbRpwIWE3skJwxbzBrCVQSoD7dTAWtuRlB9BtsbAJnY=",
    "SHA256:mX0C7prp2Srg3lPQA5rQVeY3p676qKlanrREmh7H7Zw",
);

pub(crate) const ECDSAB384: (&str, &str) = (
    "ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBIfS0qJmeg5/IE2enxn5qA+02gkVa1Lw8M2j127Gi0MCOuLq8dJFZhWMVa4prCYctWzSIjc7kFhrwTvqHdI+y6nNJofWT5tI6J1oaQCyRY5bAkXJYKOqAYGTtrQGXbJzTw==",
    "SHA256:KdkAX8igHLTOLdFxh4nM4A4sMu2N9JJZRIQ8ttk2BwQ",
);

pub(crate) const ECDSAB521: (&str, &str) = (
    "ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAEVUJoyWkzwiz3ig6U/CFwhPsUZ7Jis0v8oJvRzELWk99CJsl2W8+TepRMXkKzzXSh5LMnJCJBgDfkS2BiyEG2z8QFt9Ecvkk/VUA09t4dAMN12dgru8hYxVitOTmusbE8URG90TKWd/rf0/h+KhpyqCNiczNZlHKWpaSQilvaTmeNg+w==",
    "SHA256:GZljjhPi3CSS5lTWWXr1b1VUNzx5iJs8bnMCAo+oJIs",
);

pub(crate) const RSAB2048: (&str, &str) = (
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCn+IddKz0zXf0tYGy1pd8spbp3VBhsE1j6tYMJryyYAmTdAv0rjS3RBIECNUKdJuZRTSrIFZZDGZW0QSMzjEGTbQnWFc23GontVW91G/hbLfoJxQWHq1wCCxMLURNYgEUpKdzzdd25vE02a5xuvJ8dWz6EyRRr5PSSrgQQQuIjdVaT5R3Rb4nCxA2G2hgOIXpB2B0rJc01/LF7fBjqIPnX8sUag+KkOativlfqsExNW5+tp77k+uGr6IBvw7UotGNJJhVL+9MWoIiUJcWBHbnlzAwW3WuNLfMbrF4zAFbqHlXpQH7MZlsIy1Kl5iifCdBlDBB4/bbcPmuMNvyqSZgj",
    "SHA256:iIk4Vtt7shbQMDKF9CFFaU6EFRm7/RcvlIUKNcU/jrA",
);

pub(crate) const RSAB1024: (&str, &str) = (
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQCzctjZfwMjaHpUccaympobB+UvbcZvBfyv4Qm6hwlKh3hP+8IC2JW8cJegpXdYMU3WhNv7osnpxR/LYeh0PlZGPCVehl7uLwQCNZzNLcrZQ1osnqUQ5Pf+6RcTU8egBYu3o45Csa0mqRyJKyiGi8y9xuWNPKjG1FDH2ma29/Srpw==",
    "SHA256:oxt3Nu3S42onJp7XQvz4DpstUggiExwgDLjWqax3byk",
);
