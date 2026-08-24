import Console from "./Console.tsx";

/**
 * The queue starts empty on purpose.
 *
 * Raw untriaged carts are never rendered — in production the run is scheduled
 * and the queue is waiting when a marketer sits down, so a pile of unprocessed
 * carts isn't a state that exists. The button stands in for that schedule.
 */
export default function Page() {
  return <Console />;
}
