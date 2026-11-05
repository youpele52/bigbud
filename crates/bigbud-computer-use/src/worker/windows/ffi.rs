//! The kernel32 surface used by Windows containment, imported from the
//! approved locked `windows-sys` 0.61.2 edge (the same version as
//! bigbud-desktop-supervisor and bigbud-remote-agent). Kept as one narrow
//! import list so the unsafe call sites name exactly what they rely on.
pub(super) use windows_sys::Win32::{
    Foundation::{FILETIME, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW,
            JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
            GetProcessTimes, PROCESS_INFORMATION, ResumeThread, STARTUPINFOW, TerminateProcess,
        },
    },
};
pub(super) use windows_sys::core::BOOL;
