-- Block 9: hai DB logic độc lập trên cùng một DB server.
-- Hai database riêng (không phải hai schema) để KHÔNG THỂ mở một transaction
-- bao quanh cả hai: mỗi bên là một connection riêng, không có 2PC.
CREATE DATABASE sender;
CREATE DATABASE receiver;
