-- MySQL dump 10.13  Distrib 8.0.44, for Linux (x86_64)
--
-- Host: localhost    Database: auto_transfer_db
-- ------------------------------------------------------
-- Server version	8.0.44-0ubuntu0.24.04.2

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `transfer_request`
--

DROP TABLE IF EXISTS `transfer_request`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `transfer_request` (
  `id` varchar(50) NOT NULL,
  `ref_number` varchar(50) DEFAULT NULL,
  `bot_alias` varchar(50) DEFAULT NULL,
  `bank_type` varchar(50) DEFAULT NULL,
  `dest` varchar(50) DEFAULT NULL,
  `amount` decimal(15,2) DEFAULT NULL,
  `pin` varchar(10) DEFAULT NULL,
  `status` enum('PENDING','PROCESSING','SUCCESS','FAILED') DEFAULT 'PENDING',
  `message` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `transfer_request`
--

LOCK TABLES `transfer_request` WRITE;
/*!40000 ALTER TABLE `transfer_request` DISABLE KEYS */;
INSERT INTO `transfer_request` VALUES ('TRX-0BE72030',NULL,'nizar','seabank','901861339164',12500.00,'999995','FAILED','timeout auto rejected','2026-01-31 21:39:46','2026-01-31 21:42:10'),('TRX-12E9AB97','968908585857','nizar','seabank','901861339164',13500.00,'999995','SUCCESS','{\"status\":\"SUCCESS\",\"ref_number\":\"968908585857\",\"scan_time\":\"1/2/2026, 04.44.25\",\"details\":{\"target_name\":\"MUHAMMAD NIZAR\",\"target_rek\":\"9018 6133 9164\",\"bank\":\"SEABANK\",\"amount\":13500,\"admin\":2500,\"total\":16000}}','2026-01-31 21:43:02','2026-01-31 21:44:25'),('TRX-2B618382',NULL,'nizar','seabank','901861339167',13500.00,'999995','FAILED','Invalid Account: 901861339167','2026-01-31 22:13:41','2026-01-31 22:29:12'),('TRX-395B986E','968978587606','nizar','seabank','901861339164',20000.00,'999995','SUCCESS','{\"status\":\"SUCCESS\",\"ref_number\":\"968978587606\",\"scan_time\":\"1/2/2026, 08.18.43\",\"details\":{\"target_name\":\"MUHAMMAD NIZAR\",\"target_rek\":\"9018 6133 9164\",\"bank\":\"SEABANK\",\"amount\":20000,\"admin\":2500,\"total\":22500}}','2026-02-01 01:16:50','2026-02-01 01:18:43'),('TRX-52BFF47F',NULL,'nizar','seabank','901861339164',15500.00,'999995','FAILED','timeout auto rejected','2026-02-01 00:30:40','2026-02-01 00:32:45'),('TRX-6E661E06',NULL,'nizar','seabank','901861339167',15500.00,'999995','FAILED','Invalid Account: 901861339167','2026-01-31 22:31:09','2026-01-31 22:32:08'),('TRX-823D1845',NULL,'nizar','seabank','901861339167',15500.00,'999995','FAILED','Saldo Kurang','2026-01-31 23:15:33','2026-02-01 00:15:38'),('TRX-82548028',NULL,'nizar','seabank','901861339164',12500.00,'999995','FAILED','timeout auto rejected','2026-01-31 21:27:08','2026-01-31 21:40:53'),('TRX-87103CBA',NULL,'nizar','seabank','901861339167',13500.00,'999995','FAILED','Saldo Kurang','2026-01-31 22:02:22','2026-01-31 22:26:46'),('TRX-B0352AA7',NULL,'nizar','seabank','901861339167',13500.00,'999995','FAILED','Invalid Account: 901861339167','2026-01-31 22:28:19','2026-01-31 22:30:01'),('TRX-B36A86CE',NULL,'nizar','seabank','901861339167',15500.00,'999995','FAILED','Invalid Account: 901861339167','2026-02-01 00:29:42','2026-02-01 00:30:25');
/*!40000 ALTER TABLE `transfer_request` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `transfer_validations`
--

DROP TABLE IF EXISTS `transfer_validations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `transfer_validations` (
  `task_id` varchar(50) NOT NULL,
  `device_id` varchar(50) DEFAULT NULL,
  `account_name` varchar(100) DEFAULT NULL,
  `target_name_extracted` varchar(100) DEFAULT NULL,
  `target_rek_extracted` varchar(50) DEFAULT NULL,
  `bank_name` varchar(50) DEFAULT NULL,
  `total_amount` decimal(15,2) DEFAULT NULL,
  `status` enum('WAITING','PROCEED','ABORT') DEFAULT 'WAITING',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`task_id`),
  CONSTRAINT `transfer_validations_ibfk_1` FOREIGN KEY (`task_id`) REFERENCES `transfer_request` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `transfer_validations`
--

LOCK TABLES `transfer_validations` WRITE;
/*!40000 ALTER TABLE `transfer_validations` DISABLE KEYS */;
INSERT INTO `transfer_validations` VALUES ('TRX-0BE72030','R9CX402MZEV','nizar','MUHAMMAD NIZAR','9018 6133 9164','SEABANK',15000.00,'ABORT','2026-01-31 21:41:48','2026-01-31 21:42:10'),('TRX-12E9AB97','R9CX402MZEV','nizar','MUHAMMAD NIZAR','9018 6133 9164','SEABANK',16000.00,'PROCEED','2026-01-31 21:43:55','2026-01-31 21:44:13'),('TRX-395B986E','R9CX402MZEV','nizar','MUHAMMAD NIZAR','9018 6133 9164','SEABANK',22500.00,'PROCEED','2026-02-01 01:17:53','2026-02-01 01:18:31'),('TRX-52BFF47F','R9CX402MZEV','nizar','MUHAMMAD NIZAR','9018 6133 9164','SEABANK',18000.00,'ABORT','2026-02-01 00:31:44','2026-02-01 00:32:45'),('TRX-82548028','R9CX402MZEV','nizar','MUHAMMAD NIZAR','9018 6133 9164','SEABANK',15000.00,'ABORT','2026-01-31 21:27:46','2026-01-31 21:40:53');
/*!40000 ALTER TABLE `transfer_validations` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-02-03 19:06:39
