/**
 * Build-time activation switch for Rust SSH ownership (S4).
 *
 * This is the **single documented switch point** for the production cutover
 * described in `docs/plans/2026-11-23-rust-ssh-ownership-s4-cutover-design.md`
 * §f. It is deliberately a module constant, never an environment read, so a
 * runtime environment variable cannot enable or disable managed SSH ownership
 * in a release build.
 *
 * - `false` (this branch): production composition is inert. The dev fixture
 *   selector and every legacy launch remain exactly as they are today.
 * - `true` (W7): the production owner composition runs unconditionally on the
 *   supported profiles, every legacy launch fence refuses, and a missing or
 *   unverified owner artifact means SSH is unavailable while local features
 *   keep working.
 *
 * W7 changes this one constant in the same change set that deletes legacy rows
 * 1–51 and the type dependents D1–D5. Nothing else may read a runtime switch
 * for owner selection.
 *
 * @module SshOwnerActivation
 */

export const SSH_OWNER_PRODUCTION_ACTIVATION: boolean = false;
