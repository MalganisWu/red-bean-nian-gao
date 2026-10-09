export interface SpecPageHeaderProps {
  title: string
  description: string
  note: string
}

export function SpecPageHeader({ title, description, note }: SpecPageHeaderProps) {
  return (
    <header className="spec-page__header">
      <h2>{title}</h2>
      <p>{description}</p>
      <span>{note}</span>
    </header>
  )
}
