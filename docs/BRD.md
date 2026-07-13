# Business Requirements Document (BRD)

## Project: SaaS Gold Business POS & Licensing Platform

---

## 1. Document Control
*   **Version:** 1.0.0
*   **Status:** Final / Approved
*   **Author:** Antigravity AI Coding Assistant
*   **Target Audience:** Platform Owners, Developers, Retail Operators

---

## 2. Project Overview & Business Value

### 2.1 Purpose
The Gold Business POS is a lightweight, responsive SaaS system designed for precious metal retail shops. It provides store managers with automated gold pricing calculations, bi-directional making charge inputs, and customer advance ledgers. Additionally, it equips platform owners with a central licensing authority to manage tenant access.

### 2.2 Core Business Objectives
*   **Zero-Maintenance Operations:** Buildless ESM frontend architecture and serverless-ready backend modules to eliminate dependency rot and software breakages for 20+ years.
*   **Client Privacy Compliance:** Client databases are kept decentralized on localized tenant installations. No customer-identifiable information (CII) or sales transaction details are exposed to the platform developer during standard monitoring.
*   **Owner Licensing Gate:** SaaS owner can suspend or expire licenses remotely. POS clients enforce these rules locally, allowing a 7-day offline grace period to prevent store disruption during network drops.
*   **Doomsday Recovery Support:** If client databases are corrupted, developers can securely pull transaction histories using a one-way encrypted asymmetric cryptographic envelope (decryptable only offline by the developer's private key).

---

## 3. Scope of Requirements

### 3.1 Purity Rules & Gold Price Management
*   **Multiple Purities:** Support gold calculations for 24K, 22K, and 18K purities.
*   **Keyless Sync Default:** Auto-fetch gold rates daily at midnight from Yahoo Finance (spot futures) and exchange rate engines without requiring tenant API key registrations.
*   **Independent Overrides:** Allow store managers to manually overwrite pricing rates per carat individually (e.g. override 22K while keeping 24K and 18K auto-synced).

### 3.2 Store Manager POS Billing Desk
*   **Grams Multiplication:**
    $$\text{Base Value} = \text{Gold Weight (g)} \times \text{Active Purity Price (per gram)}$$
*   **Bi-directional Making Charges:**
    *   Casher can input making charge percentage (clamped strictly between `1%` and `100%`). Flat currency value updates instantly.
    *   Cashier can input flat currency making charge value. Percentage updates instantly.
*   **Discounts & Advances:** Support flat discount entries (defaulting to `0`) and lookup/deduction of available customer advances.

### 3.3 Customer Advances Portal
*   **Access Gate:** Secure mobile login using 10-digit phone number validations.
*   **Ledger Listing:** Scrollable payment history sheet formatted like a high-contrast printed PDF.
*   **Double Payment Protocol:**
    *   *Online Pay:* Razorpay checkout integration with backend HMAC-SHA256 signature verification.
    *   *Manual Fallback:* Offline-rendered UPI QR canvas codes for customer scans, prompting a 12-digit transaction reference ID input for manual verification.

### 3.4 Diagnostics & Telemetry
*   **Level 1 (Technical Monitoring):** Plaintext technical metrics (latency, memory footprint, CPU, error logs) with zero customer data.
*   **Level 2 (Database Export):** Asymmetric envelope packaging data under RSA-4096 + AES-256-GCM, decryptable only offline by the developer.

---

## 4. Non-Functional Requirements

### 4.1 UI/UX Non-Negotiables
*   **Locked Viewports:** Entire body locked to exactly `100vh`. Standard body scrolls are prohibited.
*   **Local Panels:** Table overflows must be contained inside specific paginated sub-panels.
*   **Aesthetic Guidelines:** Low-saturation, high-contrast slate grids (similar to a paper ledger). No vibrant dopamine-inducing palettes.

### 4.2 Security & Data Integrity
*   **Atomic Database Writes:** JSON files must write to a `.tmp` file first and then rename to prevent corruption.
*   **Asymmetric Licensing Sync:** Central server signs activation states using RSA-2048 private keys. Clients verify signatures using public keys.
*   **Rolling Backups:** Retain the last 7 daily snapshots of JSON databases.
