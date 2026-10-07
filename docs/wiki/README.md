# D1 wiki

User and developer guides for the two applications in this repository, with screenshots.

| | |
|---|---|
| [![The Force App](images/force-app/record-live.png)](force-app/README.md) | [![The D1 Database in Directus](images/database/home.png)](database/README.md) |
| **[Force App](force-app/README.md)**: the Windows desktop app that records, views and analyses machining forces from the dynamometer, and saves each cut into the database | **[D1 Database](database/README.md)**: the lab's records (samples, operations, tests, tooling, force and FAST data), in PostgreSQL with Directus 11 as the web interface |

## Where to start

- **Operating the rig?** [Force App → Getting started](force-app/getting-started.md), then
  [Recording a cut](force-app/recording.md).
- **Reviewing results?** [The Plot dashboard](force-app/plot-dashboard.md). The same dashboard is
  *Force Analysis* in Directus.
- **Registering samples and logging work?** [D1 Database → Getting started](database/getting-started.md),
  then [Samples](database/samples.md) and [Operations and tests](database/operations-and-tests.md).
- **Following a project, campaign or sample?** [Explorer pages](database/explorer-pages.md).
- **Running the server?** [Administration](database/administration.md).
- **Changing the code?** The developer guides for the [Force App](force-app/developer-guide.md) and
  the [database](database/developer-guide.md).
- **Something broken?** [Force App troubleshooting](force-app/troubleshooting.md) and the
  [known issues](database/known-issues.md).

## About the screenshots

All screenshots were taken on 26 September 2026 from a local stack built from this repository:
the Force App as on `main` (v0.1.30 plus the not yet released interface refresh of PR #73) with
its simulated signal source and mock Lab Amp, Directus 11 with the D1 extensions, and a small
**demo dataset**. Demo people are `Demo PI`, `Demo Researcher` and `Demo
Operator`, all at `example.com`; the project is `DEMO-001`; samples are `101`–`104`. No real lab
data, people or measurements appear. Where a screenshot needed something the local stack could
not produce, its caption says what was substituted.

The wiki lives in the repository (`docs/wiki/`), so it is reviewed and versioned with the code it
describes. To refresh a screenshot, rebuild the demo stack as described in the developer guides
and replace the PNG under `docs/wiki/images/`. Keep it compressed (`pngquant`) and free of real
data.
