# IIIT Hyderabad Ada User Guide

- Source: https://hpc.iiit.ac.in/wiki/index.php?title=Ada_User_Guide
- Retrieved: 2026-09-06 (Asia/Kolkata)
- Offline copy: `ada_user_guide.html`
- SHA-256: `916dd281e394f30eab7970e9ba35e108fdebd77c44dcee5958d2e2aa149769d9`
- MediaWiki revision ID reported by the downloaded page: `96`

Use the offline HTML as the authoritative operational reference for the Ada
cluster configuration. Re-check the live guide before long-running experiments
because partitions, quotas, QOS policies, hardware availability, and scheduler
rules may change.

Key operational constraints captured from the downloaded revision:

- Ada uses Slurm for scheduling and resource management.
- The login node is for source code, compilation, data transfer, inspection,
  and job submission; compute work must be scheduled.
- The guide documents `short` and `long` partitions and GTX 1080 Ti / RTX 2080
  Ti nodes, but actual availability must be checked with Slurm at run time.
- Interactive `srun` jobs have a six-hour limit; longer work must use `sbatch`.
- Storage includes `/home`, `/share1`, `/scratch`, and `/ssd_scratch`; scratch
  data is temporary and subject to purging.
- Record account, QOS, partition, GPU, CPU, memory, wall time, job ID, stdout,
  stderr, and exit status for every experiment.
