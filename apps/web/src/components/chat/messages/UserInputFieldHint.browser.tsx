import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { UserInputFieldHint } from "./UserInputFieldHint";

it("shows optionality, exact closed-choice constraints and input bounds without misleading legacy questions", async () => {
  const base = { id: "count", header: "Count", question: "Count?", options: [] };
  const screen = await render(
    <UserInputFieldHint
      question={{
        ...base,
        field: { type: "integer", required: false, allowCustom: true, minimum: 1, maximum: 3 },
      }}
    />,
  );
  await expect.element(screen.getByText(/Optional — leave blank to skip/)).toBeVisible();
  await expect.element(screen.getByText(/minimum 1 · maximum 3/)).toBeVisible();
  await screen.rerender(
    <UserInputFieldHint
      question={{
        ...base,
        options: [{ id: "one", label: "Same", description: "First" }],
        field: { type: "string", required: true, allowCustom: false },
      }}
    />,
  );
  await expect
    .element(screen.getByText(/Required · string · Choose from the listed options/))
    .toBeVisible();
  await screen.rerender(<UserInputFieldHint question={base} />);
  await expect.element(screen.getByText(/Required/)).not.toBeInTheDocument();
  await screen.rerender(
    <UserInputFieldHint
      question={{
        ...base,
        multiSelect: true,
        field: { type: "multiselect", required: true, allowCustom: true, minItems: 2 },
      }}
    />,
  );
  await expect.element(screen.getByText(/Custom entries: enter a JSON string array/)).toBeVisible();
  await expect.element(screen.getByText(/Combined with selected options/)).toBeVisible();
});
