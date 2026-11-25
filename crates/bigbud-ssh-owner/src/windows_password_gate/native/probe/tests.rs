use super::*;
use std::os::windows::io::{AsHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT},
    Storage::FileSystem::SYNCHRONIZE,
    System::Threading::{GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

pub(super) const TARGET: TargetGeneration<'_> = TargetGeneration {
    target: "isolated-native-launch-fixture",
    generation: 9,
};
pub(super) const STALE: TargetGeneration<'_> = TargetGeneration {
    generation: 10,
    ..TARGET
};
const STAND_IN: &str = "windows_password_gate::native::probe::tests::ssh_stand_in";

pub(super) fn plan(test: &str) -> PasswordProbePlan<'static> {
    let image = std::env::current_exe().unwrap();
    let image = GuardedLocalPath::new(&image).unwrap();
    let recipe = recipe::Recipe::fixture(&image, test).unwrap();
    // SAFETY: opens a fresh, least-privilege handle to this test owner.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            std::process::id(),
        )
    };
    assert!(!raw.is_null());
    // SAFETY: successful OpenProcess transferred ownership of the test handle.
    let owner = unsafe { OwnedHandle::from_raw_handle(raw) };
    let owner =
        ExpectedPipePeer::from_spawned_image(owner.as_handle(), recipe.ssh.dos_path()).unwrap();
    PasswordProbePlan {
        owner,
        target: TARGET,
        recipe,
    }
}

#[test]
fn retains_owner_handle_through_the_real_native_process_launch() {
    let probe = PasswordUnlockProbe::launch(TARGET, plan(STAND_IN)).unwrap();
    assert_eq!(
        probe
            .active
            .as_ref()
            .unwrap()
            .wait_for_exit(Duration::from_secs(5))
            .unwrap(),
        0
    );
}

#[test]
fn wrong_generation_refuses_before_launch_or_revokes_the_live_job() {
    let wait = "windows_password_gate::native::probe::tests::ssh_waits_for_revocation";
    assert!(PasswordUnlockProbe::launch(STALE, plan(wait)).is_err());
    let mut probe = PasswordUnlockProbe::launch(TARGET, plan(wait)).unwrap();
    let process = probe.active.as_ref().unwrap().clone_process().unwrap();
    assert!(probe.receive(STALE, IO_BUDGET).is_err());
    assert!(probe.active.is_none());
    assert!(probe.endpoint.is_none());
    assert!(spawn::wait_for_exit(&process, Duration::from_secs(5)).unwrap() != 0);
}

#[test]
fn ssh_stand_in() {
    let Ok(bootstrap) = std::env::var(PasswordHelperBootstrap::ENV) else {
        return;
    };
    let (_, handle) = bootstrap.rsplit_once(':').unwrap();
    let handle = usize::from_str_radix(handle, 16).unwrap() as HANDLE;
    let mut flags = 0;
    // SAFETY: Windows validates the inherited handle number; flags is a live slot.
    assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
    assert_ne!(flags & HANDLE_FLAG_INHERIT, 0);
    // SAFETY: process handle validation is delegated to Windows.
    assert_ne!(unsafe { GetProcessId(handle) }, 0);
    assert_eq!(std::env::var("SSH_ASKPASS_REQUIRE").as_deref(), Ok("force"));
    assert_eq!(std::env::var("DISPLAY").as_deref(), Ok("bigbud:0"));
    assert!(std::env::var_os("SSH_AUTH_SOCK").is_none());
}

#[test]
fn ssh_waits_for_revocation() {
    if std::env::var_os(PasswordHelperBootstrap::ENV).is_some() {
        // No fixture success: the parent must close the job instead.
        std::thread::sleep(Duration::from_secs(30));
    }
}
