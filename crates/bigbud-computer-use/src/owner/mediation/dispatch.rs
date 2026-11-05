//! Native final-dispatch check for one admitted operation (plan M2.dispatch).
//! Every helper frame must be the next expected step of the admitted action,
//! carry only typed model arguments (never an owner field), keep the admitted
//! delivery, stay inside the referenced observation's frame, and is then
//! stamped with the owner's exact session/target/capture values and
//! re-serialized. Any refusal closes the operation: no later frame of a
//! partially forwarded sequence can run. Dormant: not wired to a transport.
use super::frame::{FrameRefusal, ToolCall, encode_tool_call, parse_tool_call};
use super::held_input::{HeldInput, possibly_held};
use super::profile::{SCROLL_CHUNK_MAX, Stamp, Tool, admits};
use super::ticket::{Admitted, CAPTURE, Expect, Ticket};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchRefusal {
    InvalidTicket,
    Frame(FrameRefusal),
    /// Not the next expected step, after the last step, or after a refusal.
    Unexpected,
    /// The model tried to supply an owner-only field.
    OwnerField(&'static str),
    InvalidArgument(&'static str),
    MissingTarget,
    MissingObservation,
    OutsideFrame,
    /// A later frame of the operation names another session or target.
    TargetChanged,
}

impl DispatchRefusal {
    /// Frozen public v2 error code.
    pub fn code(self) -> &'static str {
        match self {
            Self::MissingTarget => "target_missing",
            Self::TargetChanged => "target_stale",
            Self::MissingObservation => "observation_missing",
            _ => "invalid_arguments",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeTarget {
    pub pid: u32,
    pub window: u64,
}

/// Pixel frame of the consumed observation (the image the model saw).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservationFrame<'a> {
    pub width: u32,
    pub height: u32,
    pub capture_id: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamps<'a> {
    pub session: &'a str,
    pub target: Option<NativeTarget>,
    pub observation: Option<ObservationFrame<'a>>,
}

/// One forwarded frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Forwarded {
    /// The only bytes sent to the Driver, carrying the owner's wire id.
    pub bytes: Vec<u8>,
    /// The caller's request id, for mapping the egress projection back.
    pub caller_id: Value,
    /// What this call may leave pressed if its outcome becomes unknown.
    pub held: Vec<HeldInput>,
}

#[derive(Debug)]
pub struct Dispatch {
    ticket: Ticket,
    plan: Vec<Expect>,
    next: usize,
    scrolled: i64,
    completed: bool,
    capture_sent: bool,
    closed: bool,
    /// Session and target of the first forwarded frame; later frames of the
    /// operation must name exactly the same ones.
    pinned: Option<(String, Option<NativeTarget>)>,
}

const TREE_FIELDS: [&str; 4] = ["tree_format", "max_elements", "max_depth", "timeout_ms"];
const COORDINATES: [(&str, &str); 3] = [("x", "y"), ("from_x", "from_y"), ("to_x", "to_y")];

impl Dispatch {
    pub fn new(ticket: Ticket) -> Result<Self, DispatchRefusal> {
        let plan = ticket.expected().ok_or(DispatchRefusal::InvalidTicket)?;
        Ok(Self {
            ticket,
            plan,
            next: 0,
            scrolled: 0,
            completed: false,
            capture_sent: false,
            closed: false,
            pinned: None,
        })
    }

    /// Every admitted step was forwarded and nothing was refused or aborted.
    pub fn finished(&self) -> bool {
        !self.closed && self.next == self.plan.len()
    }

    /// The owner observed a known completed effect after the last step; only
    /// then may a requested `captureAfter` read the same target. Claiming
    /// completion with steps outstanding refuses and closes the operation.
    pub fn complete(&mut self) -> Result<(), DispatchRefusal> {
        if !self.finished() {
            self.closed = true;
            return Err(DispatchRefusal::Unexpected);
        }
        self.completed = true;
        Ok(())
    }

    /// A Driver refusal or unknown outcome: no later step (including a
    /// `captureAfter` read) may run for this operation.
    pub fn abort(&mut self) {
        self.closed = true;
    }

    /// `wire_id` is owner-assigned, unique per worker generation and never
    /// reused, so a late reply can never be matched to another operation.
    pub fn forward(
        &mut self,
        frame: &[u8],
        stamps: &Stamps<'_>,
        wire_id: u64,
    ) -> Result<Forwarded, DispatchRefusal> {
        let result = self.check(frame, stamps, wire_id);
        if result.is_err() {
            self.closed = true;
        }
        result
    }

    fn check(
        &mut self,
        frame: &[u8],
        stamps: &Stamps<'_>,
        wire_id: u64,
    ) -> Result<Forwarded, DispatchRefusal> {
        let expect = self.expectation()?;
        let mut call = parse_tool_call(frame).map_err(DispatchRefusal::Frame)?;
        if call.tool != expect.tool() {
            return Err(DispatchRefusal::Unexpected);
        }
        check_arguments(call.tool, &call.arguments)?;
        let amount = self.check_shape(expect, &call.arguments)?;
        if let Some((session, target)) = &self.pinned
            && (session != stamps.session || *target != stamps.target)
        {
            return Err(DispatchRefusal::TargetChanged);
        }
        stamp(&mut call, expect, stamps)?;
        let caller_id = std::mem::replace(&mut call.id, Value::from(wire_id));
        let held = possibly_held(call.tool, &call.arguments);
        let bytes = encode_tool_call(&call).map_err(DispatchRefusal::Frame)?;
        if self.pinned.is_none() {
            self.pinned = Some((stamps.session.to_owned(), stamps.target));
        }
        if self.next < self.plan.len() {
            self.next += 1;
        } else {
            self.capture_sent = true;
        }
        self.scrolled += amount;
        Ok(Forwarded {
            bytes,
            caller_id,
            held,
        })
    }

    fn expectation(&self) -> Result<Expect, DispatchRefusal> {
        if self.closed {
            return Err(DispatchRefusal::Unexpected);
        }
        if let Some(expect) = self.plan.get(self.next) {
            return Ok(*expect);
        }
        if self.ticket.capture_after && self.completed && !self.capture_sent {
            return Ok(CAPTURE);
        }
        Err(DispatchRefusal::Unexpected)
    }

    /// Action-specific shape; returns the scroll amount this frame delivers.
    fn check_shape(
        &self,
        expect: Expect,
        args: &Map<String, Value>,
    ) -> Result<i64, DispatchRefusal> {
        let delivery = self.ticket.delivery.wire();
        let invalid = DispatchRefusal::InvalidArgument;
        match expect {
            Expect::Read { screenshot, depth } => {
                let tree = depth.is_some();
                if args.get("include_screenshot").and_then(Value::as_bool) != Some(screenshot)
                    || args
                        .get("include_accessibility_tree")
                        .and_then(Value::as_bool)
                        != Some(tree)
                    || TREE_FIELDS
                        .iter()
                        .any(|field| args.contains_key(*field) != tree)
                    || depth
                        .is_some_and(|d| args.get("max_depth").and_then(Value::as_i64) != Some(d))
                {
                    return Err(invalid("get_window_state"));
                }
                Ok(0)
            }
            Expect::Input(_) => same_delivery(args, delivery).map(|()| 0),
            Expect::ScrollChunk => {
                same_delivery(args, delivery)?;
                let Admitted::Scroll {
                    direction,
                    total,
                    at_point,
                } = self.ticket.admitted
                else {
                    return Err(DispatchRefusal::Unexpected);
                };
                let amount = args.get("amount").and_then(Value::as_i64);
                let chunk = (total - self.scrolled).min(SCROLL_CHUNK_MAX);
                if args.get("direction").and_then(Value::as_str) != Some(direction.wire())
                    || amount != Some(chunk)
                    || args.contains_key("x") != at_point
                    || args.contains_key("y") != at_point
                {
                    return Err(invalid("scroll"));
                }
                Ok(chunk)
            }
            Expect::Front | Expect::Plain(_) => Ok(0),
        }
    }
}

fn same_delivery(args: &Map<String, Value>, delivery: &str) -> Result<(), DispatchRefusal> {
    if args.get("delivery_mode").and_then(Value::as_str) == Some(delivery) {
        Ok(())
    } else {
        Err(DispatchRefusal::InvalidArgument("delivery_mode"))
    }
}

fn check_arguments(tool: Tool, args: &Map<String, Value>) -> Result<(), DispatchRefusal> {
    let specs = tool.args();
    for name in args.keys() {
        if let Some(owned) = Stamp::ALL.iter().find(|stamp| stamp.field() == name) {
            return Err(DispatchRefusal::OwnerField(owned.field()));
        }
        if !specs.iter().any(|spec| spec.name == name) {
            return Err(DispatchRefusal::InvalidArgument("unknown"));
        }
    }
    for spec in specs {
        match args.get(spec.name) {
            Some(value) if !admits(spec.kind, value) => {
                return Err(DispatchRefusal::InvalidArgument(spec.name));
            }
            None if spec.required => return Err(DispatchRefusal::InvalidArgument(spec.name)),
            _ => {}
        }
    }
    Ok(())
}

fn stamp(call: &mut ToolCall, expect: Expect, stamps: &Stamps<'_>) -> Result<(), DispatchRefusal> {
    let pixel_bound = matches!(call.tool, Tool::Click | Tool::Drag)
        || (expect == Expect::ScrollChunk && call.arguments.contains_key("x"));
    let observation = if pixel_bound {
        let frame = stamps
            .observation
            .ok_or(DispatchRefusal::MissingObservation)?;
        within_frame(&call.arguments, frame)?;
        Some(frame)
    } else {
        None
    };
    for field in call.tool.stamps() {
        let value = match field {
            Stamp::Session if !stamps.session.is_empty() => Value::from(stamps.session),
            Stamp::Session => return Err(DispatchRefusal::MissingTarget),
            Stamp::Pid => Value::from(stamps.target.ok_or(DispatchRefusal::MissingTarget)?.pid),
            Stamp::WindowId => {
                Value::from(stamps.target.ok_or(DispatchRefusal::MissingTarget)?.window)
            }
            Stamp::CaptureId => match observation.and_then(|frame| frame.capture_id) {
                Some(capture) => Value::from(capture),
                None => continue,
            },
        };
        call.arguments.insert(field.field().into(), value);
    }
    Ok(())
}

/// Zero-based pixels strictly inside the consumed observation's image.
fn within_frame(
    args: &Map<String, Value>,
    frame: ObservationFrame<'_>,
) -> Result<(), DispatchRefusal> {
    for (x, y) in COORDINATES {
        let (Some(x), Some(y)) = (args.get(x), args.get(y)) else {
            continue;
        };
        let inside = |value: &Value, limit: u32| {
            value
                .as_f64()
                .is_some_and(|v| v >= 0.0 && v < f64::from(limit))
        };
        if !inside(x, frame.width) || !inside(y, frame.height) {
            return Err(DispatchRefusal::OutsideFrame);
        }
    }
    Ok(())
}
