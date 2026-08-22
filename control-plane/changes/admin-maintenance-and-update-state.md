# Admin maintenance control and accurate update status

- Administrators can enter maintenance through the existing safe-drain scheduler and resume normal operation from **Admin > Updates**. Both transitions persist their requested mode and restart NeurOn coherently.
- Local Compose restarts a gracefully exited NeurOn container unless an operator explicitly stops it.
- The Updates screen now distinguishes a genuinely newer successful build from a running revision that is ahead of CI, avoiding false update notices with empty patch notes.
- Storage procedures have a separate forced-maintenance deployment setting that application administrators cannot dismiss during a protected operation.
