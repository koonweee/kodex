import { MantineProvider } from "@mantine/core";
import { render,screen } from "@testing-library/react";
import { expect,it } from "vitest";
import { GeneratedAppCard } from "./GeneratedAppCard";
it("renders read-only observer fallback without an iframe or interactive host",()=>{
  render(<MantineProvider><GeneratedAppCard card={{id:"card",title:"Comparison",fallbackContent:"Choose A or B"}}/></MantineProvider>);
  expect(screen.getByRole("region",{name:"Comparison"})).toHaveTextContent("Choose A or B");
  expect(document.querySelector('iframe')).toBeNull();
});
