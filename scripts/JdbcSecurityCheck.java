import java.sql.*;

/** Regression for GHSA-24rp-q3w6-vc56 using an isolated loopback database. */
public class JdbcSecurityCheck {
    public static void main(String[] args) throws Exception {
        try (Connection connection = DriverManager.getConnection(
                "jdbc:postgresql://127.0.0.1:5432/postgres?preferQueryMode=simple", "postgres", "postgres")) {
            for (String input : new String[] {"ordinary input", "\nSELECT 'injected'; --", "'\\\n; SELECT 42; --"}) {
                try (PreparedStatement statement = connection.prepareStatement("SELECT -?, ?")) {
                    statement.setInt(1, -1);
                    statement.setString(2, input);
                    try (ResultSet result = statement.executeQuery()) {
                        if (!result.next() || result.getInt(1) != 1 || !input.equals(result.getString(2)) || result.next()) {
                            throw new AssertionError("Parameters changed query structure");
                        }
                    }
                }
            }
        }
        System.out.println("Simple-query parameter regression and ordinary control passed");
    }
}
