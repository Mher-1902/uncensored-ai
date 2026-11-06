# Mobile session return and accuracy note

A frozen or offline mobile page can return without remounting the app. The account hook now retries the existing SDK session on pageshow, reconnect and foreground events. Concurrent triggers share one read; an account epoch change, sign-out or disposed hook cannot restore an old result. A transient initial read failure with an active saved session offers connection recovery rather than instructing another provider sign-in.

The rolling 30-day inactivity rule, explicit sign-out and temporary chats are unchanged. Each device/browser requires its own first sign-in. Browsers that block/clear storage or lack the required cross-tab lock use the existing limited fallback; this change cannot override browser storage policy.

A small muted note below the composer says “OffScript is an AI and can make mistakes. Check important information.”

Samsung validation: both builds and SEO checks passed; 205 Node tests and the Python suite passed. New real-SDK fixtures cover one refresh after mobile return, reconnect without clearing credentials, and sign-out during a pending read. Offline container: 0.25 CPU, 1536 MiB, no swap; peak 56°C. Physical phone/iPad proof remains pending. This increment does not change inference speed or establish capacity.
