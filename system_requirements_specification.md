# System Requirements Specification

## 1. Context & Executive Summary
* **Current State:** A research laboratory manages physical samples, material stocks, manufacturing logs, specialized tooling components, and heavy experimental files via a low-code front-end (AppSheet) mapped to a flat, multi-tab spreadsheet backend (Google Sheets).
* **Core Pain Points:**
  * **Relational Failure:** Spreadsheets cannot natively handle deeply nested hierarchical dependencies (e.g., Tool Box $\rightarrow$ Multi-edged Insert $\rightarrow$ Specific Cutting Edge).
  * **Data Ingestion Bottlenecks:** Manual workflows fail to capture programmatic, real-time data dumps from laboratory equipment and analysis engines (e.g., MATLAB).
  * **Scalability Limitations:** Standard HTTP body payloads and web servers crash or exhaust system RAM when handling large experimental datasets ranging from 10 GB to 100 GB.
  * **Accountability & Compliance Gaps:** Lack of multi-user role tracking leads to unrecorded modifications, overwrite collisions, and non-existent scientific data histories.
  * **Brittle Schema Architecture:** Hardcoding columns for manufacturing processes limits the introduction of new experimental methodologies without modifying database structures.
* **Objective:** Establish a highly maintainable, free, open-source, fully self-hosted, API-first system that bridges material genealogy, dynamic manufacturing execution logs, nested tooling tracking, and high-capacity automated data workflows. The underlying architecture must be structured strictly according to industry standards to enable a local, self-hosted LLM to programmatically query the database via natural language text-to-SQL.

---

## 2. Dynamic Relational Data Model & Hierarchies
To achieve true flexibility, the system must enforce strict relational constraints, eliminate data duplication, and completely avoid hardcoded engineering variables. It uses a **Dynamic Process Template Pattern** (or JSONB schema mapping) to allow administrators to design custom manufacturing and testing profiles from the application UI without modifying code.

### A. Material Genealogy & Stock Tracking (The Ancestors)
* **Raw Stock Ledger:** Tracks incoming material lots prior to form-giving operations.
  * *Stock Types:* Swarf, Raw Powder, Billets, Chemical Batches.
  * *Attributes:* Supplier, Material Grade, Mesh Size/Purity, Associated Data Sheets, Total Inbound Mass, Current Remaining Mass.
  * *Relational Rule:* Every manufactured sample must link back to one or more records in this ledger to maintain material provenance.

### B. Dynamic Manufacturing & Execution Configuration (The Blueprints)
Rather than hardcoding process-specific attributes, the system leverages a metadata configuration engine:
1. **Manufacturing Methods Table:** Defines the categories of physical transformation (e.g., *Sintering, CNC Machining, Laser Melting, Heat Treatment*).
2. **Method Parameters Table:** An administrative table defining the attributes required for a specific method.
   * *Fields:* `parameter_name` (e.g., Peak Temperature, Feed Rate), `data_type` (*Numeric, String, Boolean, File Link*), and `unit_of_measure` (*°C, mm/min, Bar, RPM*).

### C. The Physical Sample Lifecycle & Logs (The Execution)
* **Physical Samples Table:** Tracks the central physical entity. It holds a distinct, permanent primary identifier (e.g., GUID or serialized barcode) generated upon the sample's creation.
* **Manufacturing Operations Table:** Acts as the chronologically sequenced life events of a sample.
  * *Fields:* `operation_id`, `sample_id` (FK), `method_id` (FK), `operator_id`, `timestamp`.
  * *Attributes:* Managed via a PostgreSQL `JSONB` column named `recorded_metadata`. This single cell holds arbitrary structured key-value pairs dictated by the chosen method's parameters (e.g., `{"atmosphere": "Argon", "spindle_speed_rpm": 4500}`).

### D. Physical Tooling & Consumables Hierarchy (Deeply Nested)
1. **Tool Box (Grandparent):** Storage unit containing specific tooling classes or batches.
2. **Cutting Insert (Parent):** Individual multi-edged insert tracked inside a specific Tool Box.
3. **Insert Edge (Child):** Sub-component representing the discrete point of physical contact during processing or testing. Every Cutting Insert contains $N$ Insert Edges. 
   * *Relational Rule:* The specific `Insert_Edge_ID` must be explicitly logged within any Machining Operation or Test Session that consumes it.

### E. Test Sessions Ledger (The Final State)
* **Test Sessions Table:** A relational junction table documenting experimental trials.
  * *Fields:* `unique_session_id` (UUID), `sample_id` (FK), `equipment_id` (FK), `insert_edge_id` (FK), `timestamp`, `operator_id`, `file_storage_pointer` (URI string).

---

## 3. High-Capacity Data & Automation Pipeline

Because raw data files routinely scale between **10 GB and 100 GB** per experimental run, standard HTTP application layers must be completely bypassed to prevent Out-Of-Memory (OOM) crashes.

```text
[ MATLAB / Test Rig Client ]
│
├── 1. GET /api/samples/{id} ───────────────> [ Core Application API ]
│                                                   │ (Returns Dimensions, Material)
├── 2. [ Executes Physical Test Campaign ]          │
│                                                   ▼
├── 3. S3 Multipart Upload (Chunked 10GB+) ───> [ Local MinIO Object Storage ]
│                                                   │ (Returns Permanent Object URI)
└── 4. POST /api/sessions (Passes Storage URI) ─> [ Core Application API ]
                                                             │
                                                             ▼ (Asynchronous Webhook Trigger)
                                              [ Heavy Data Worker Container ]
                                      (Memory-Mapped Parsing & Statistical Analysis)
                                                             │
                                                             ▼
                                             [ POST /api/sessions/{id}/plots ]
                                         (Appends Summary Stats & Visualizations)
```

### Step 1: Programmatic Metadata Query
* Before initiating processing or testing, the machine endpoint or software client (e.g., MATLAB) executes an authenticated `GET` request to `/api/samples/{id}` using a hardware barcode scan or input string.
* The system returns the sample's complete physical profile (material, dimensions, processing status) in JSON format.

### Step 2: Direct-to-Object-Storage Bypass
* The test execution completes, saving a high-frequency multi-gigabyte datafile locally on the test rig client.
* The client invokes an **S3 Multipart Upload** protocol using chunks (e.g., 50MB–100MB segments) to stream the large data file directly to a local, self-hosted object storage server (**MinIO**).
* This bypass prevents the application API from proxying heavy binaries. MinIO confirms completion and issues a permanent file URI.

### Step 3: Session Registry Ingestion
* The client executes a lightweight `POST` request to `/api/sessions/` (or `/api/operations/`), providing the core relational foreign keys alongside the MinIO `file_storage_pointer` URI.

### Step 4: Streamed Asynchronous Data Processing
* The ingestion of a new session triggers a server-side webhook, placing a job into a high-throughput queue (e.g., Redis-backed Celery or RabbitMQ).
* A separate, headless **Data Worker Container** (Python/Octave) picks up the job.
* **Memory Management Constraint:** The worker must read the data file via streaming or memory-mapping (e.g., chunked HDF5, NumPy memmap, or binary streams) to extract summary statistics and render compressed vector visualizations (SVG/PNG plots).
* The worker writes back the computed metrics and image URLs directly to the original session record via the API, making them immediately viewable in the browser.

---

## 4. Multi-User Access, Concurrency, & Audit Logging

To preserve scientific data integrity across multi-user environments, the system implements rigorous tracking mechanisms.

### A. Authentication & Programmatic Nodes
* Human interactions are governed by strict Role-Based Access Control (RBAC), isolating privileges between `Operators` (logging operations), `Researchers` (running tests and analyses), and `Administrators` (configuring methods and parameters).
* Equipment nodes and script engines (MATLAB) authenticate via secure, revocable long-lived **API Bearer Tokens** mapped to unique system-user profiles (e.g., `Rig_1_Fast_Sampling_Node`).

### B. Immutable Audit Logs (Change History)
* Every data mutation (`INSERT`, `UPDATE`, `DELETE`) on core entities must automatically trigger an event that writes to an isolated, append-only `audit_logs` table.
* The record must log the exact `timestamp`, `user_id` or token, `action_type`, `target_table`, `record_id`, and a structured JSON payload defining the state delta:
  ```json
  {
    "field_modified": "sample_weight_grams",
    "previous_value": "452.18",
    "updated_value": "449.02"
  }
  ```

### C. Concurrency Control
* The system handles race conditions between manual front-end web edits and automated machine API updates using Optimistic Concurrency Control (OCC).
* Tables include an incremental version field or precise millisecond timestamp verification (`updated_at`). Conflicting updates are safely rejected, forcing the client engine to fetch refreshed states before re-submitting.

---

## 5. UI Layout & Complete Traceability Requirements

The front-end user experience must prioritize complete bi-directional click-through traceability, replacing disconnected tabs with an integrated chronological view.

* **Cradle-to-Grave Sample Timeline:** Looking up an individual Sample displays its complete digital twin trajectory across time:

  $$\text{Raw Material Stock Lot} \longrightarrow \text{Sintering Operation (Log + Curve File)} \longrightarrow \text{Machining Operation (Tooling Info)} \longrightarrow \text{Sequential Test Campaigns}$$

* **Forward Traceability:** Clicking any historical node immediately expands operator details, asset utilization records, and processing metadata.
* **Reverse Traceability:** Inspecting any deep storage file or test session output exposes click-through breadcrumbs tracing the entire lineage back to the originating components:

  $$\text{10GB+ Raw File} \longrightarrow \text{Test Session ID} \longrightarrow \text{Specific Insert Edge} \longrightarrow \text{Parent Insert} \longrightarrow \text{Tool Box}$$

---

## 6. AI-Readiness & Local Text-to-SQL Optimization

To ensure a self-hosted LLM (e.g., Llama-3, Mistral deployed via Ollama) can natively parse and answer queries regarding experimental data, the data layer must implement semantic readability standards.

* **Deterministic Naming Conventions:** Cryptic abbreviations are strictly banned. Column names must be fully descriptive and incorporate their explicit scientific units (e.g., `temperature_celsius`, `mass_grams`, `feed_rate_mm_per_min`).
* **Explicit Relational Constraints:** Schema mapping must rely on native database `FOREIGN KEY` declarations and constraints rather than application-level logical links. This populates the PostgreSQL `information_schema` with a coherent map that the LLM uses to correctly synthesize complex table joins without hallucination.
* **Semantic Schema Dictionary:** Every table and column definition must contain a native database `COMMENT` string, providing explicit business-logic explanations, data formats, and physical contexts.
* **Database Views Abstraction Layer:** The database must expose simplified, flattened relational SQL Views (prefixed with `v_`, such as `v_complete_sample_history`). These views consolidate multi-table operations and hierarchical lineages into singular flat targets, allowing local LLMs with restrictive context windows to generate accurate, optimized SQL strings.
* **Vector Embeddings Extension:** The core PostgreSQL engine must run the `pgvector` extension to allow future storage and hybrid semantic indexing of unstructured testing text notes or algorithm outputs alongside structured metadata.

---

## 7. Infrastructure, Deployment, & Maintainability

The system infrastructure must be fully vendor-agnostic, built on standardized technology stacks, and simple to backup and deploy.

* **The Core Stack:**
  * **Database Engine:** PostgreSQL (v15+) ensuring relational reliability, JSONB indexing capabilities, and pgvector support.
  * **Object Storage Layer:** Local MinIO deployment, acting as an abstraction layer for storage hardware while matching Amazon S3 API protocols (ensuring compatibility with standard MATLAB AWS toolboxes).
  * **API Framework:** Python-based FastAPI or an enterprise open-source data gateway like Directus (leveraging its built-in Many-to-Any relationship models for dynamic form rendering).
* **Network Requirements:** Physical hardware infrastructure should connect through a Gigabit Ethernet switch backend (preferably 10GbE local trunks) to facilitate continuous multi-gigabyte dataset transfers without degrading network bandwidth.
* **Orchestration:** The total runtime environment—including database instances, caching layers, storage buckets, application APIs, and worker daemons—must be packaged and launched as an infrastructure-as-code configuration via a single, self-contained `docker-compose.yml` script.
