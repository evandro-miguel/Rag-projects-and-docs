def parse_csv_line(line: str) -> list[str]:
    return [segment.strip() for segment in line.split(",")]
