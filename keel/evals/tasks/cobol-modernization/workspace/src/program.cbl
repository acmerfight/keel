       IDENTIFICATION DIVISION.
       PROGRAM-ID. VIPREPORT.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT CUSTOMER-FILE ASSIGN TO "data/CUSTOMER.DAT"
               ORGANIZATION IS LINE SEQUENTIAL.
           SELECT REPORT-FILE ASSIGN TO "REPORT.TXT"
               ORGANIZATION IS LINE SEQUENTIAL.
       DATA DIVISION.
       FILE SECTION.
       FD CUSTOMER-FILE.
       01 CUSTOMER-REC.
          05 CUSTOMER-ID      PIC X(3).
          05 CUSTOMER-NAME    PIC X(10).
          05 CUSTOMER-STATUS  PIC X(1).
          05 CUSTOMER-BALANCE PIC 9(5).
       FD REPORT-FILE.
       01 REPORT-LINE         PIC X(32).
       WORKING-STORAGE SECTION.
       01 EOF-FLAG            PIC X VALUE "N".
       PROCEDURE DIVISION.
           OPEN INPUT CUSTOMER-FILE
           OPEN OUTPUT REPORT-FILE
           PERFORM UNTIL EOF-FLAG = "Y"
               READ CUSTOMER-FILE
                   AT END MOVE "Y" TO EOF-FLAG
                   NOT AT END
                       IF CUSTOMER-STATUS = "A"
                          AND CUSTOMER-BALANCE >= 05000
                          STRING CUSTOMER-ID DELIMITED BY SIZE
                                 " " DELIMITED BY SIZE
                                 FUNCTION TRIM(CUSTOMER-NAME)
                                 " $" DELIMITED BY SIZE
                                 CUSTOMER-BALANCE DELIMITED BY SIZE
                            INTO REPORT-LINE
                          WRITE REPORT-LINE
                       END-IF
               END-READ
           END-PERFORM
           CLOSE CUSTOMER-FILE
           CLOSE REPORT-FILE
           STOP RUN.
